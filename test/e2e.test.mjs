// End-to-end test: spawns the real server on a test port, exercises all
// three routes, and validates the scheduling rules and the generated docx.
//   npm test  (from server/)
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import PizZip from 'pizzip'

const PORT = 3999
const BASE = `http://127.0.0.1:${PORT}`
const root = dirname(dirname(fileURLToPath(import.meta.url)))

const server = spawn('node', [join(root, 'index.js')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'inherit',
})

try {
  // wait for the health route
  let up = false
  for (let i = 0; i < 40 && !up; i++) {
    try {
      const res = await fetch(`${BASE}/`)
      up = (await res.json()).ok === true
    } catch {
      await sleep(250)
    }
  }
  assert.ok(up, 'server did not come up')

  const weekDates = {
    // June 2026: 1st is a Monday.
    1: [1, 2, 3, 4],
    2: [7, 8, 9, 10, 11],
    3: [14, 15, 16, 17, 18],
    4: [21, 22, 23, 24, 25, 27, 28],
  }
  const body = {
    year: 2026,
    month: 6,
    weekDates: [weekDates[1], weekDates[2], weekDates[3], weekDates[4]],
    supervisors: [
      { name: 'Dr. Rahman', hoursPerWeek: 9 },
      { name: 'Ms. Akter', hoursPerWeek: 9 },
    ],
    courses: [
      { dayCode: 'MW', startTime: '16:20', endTime: '17:50' },
      { dayCode: 'S', startTime: '13:00', endTime: '14:30' },
      { dayCode: 'AR', startTime: '13:00', endTime: '14:30' },
      { dayCode: 'R', startTime: '14:40', endTime: '16:10' },
      { dayCode: 'M', startTime: '18:30', endTime: '21:30' },
      { dayCode: 'S', startTime: '18:30', endTime: '21:30' },
    ],
  }

  /* ---------------- schedule generation ---------------- */
  const schedRes = await fetch(`${BASE}/api/generate-schedule`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const sched = await schedRes.json()
  assert.equal(sched.success, true, JSON.stringify(sched))
  assert.equal(sched.results.length, 2)

  const classWindows = {} // weekday -> [start,end][]
  for (const c of body.courses) {
    const dows = { S: [0], M: [1], T: [2], W: [3], R: [4], F: [5], A: [6], MW: [1, 3], ST: [0, 2], AR: [6, 4] }[c.dayCode]
    for (const d of dows) {
      classWindows[d] = classWindows[d] || []
      classWindows[d].push([
        Number(c.startTime.split(':')[0]) * 60 + Number(c.startTime.split(':')[1]),
        Number(c.endTime.split(':')[0]) * 60 + Number(c.endTime.split(':')[1]),
      ])
    }
  }

  const byDate = {} // date -> [start,end][] across supervisors
  for (const { supervisor, schedule } of sched.results) {
    let total = 0
    schedule.weeks.forEach((week, wi) => {
      let weekMin = 0
      for (const s of week) {
        assert.ok(s.start >= 8 * 60 && s.end <= 18 * 60, 'inside duty window')
        assert.ok(s.end - s.start >= 60, 'session >= 1h')
        assert.equal(s.start % 30, 0, 'start snapped to 30min')
        assert.ok(weekDates[wi + 1].includes(s.date), 'session on an eligible date')
        // never overlaps a class on that weekday
        const dow = new Date(2026, 5, s.date).getDay()
        for (const [cs, ce] of classWindows[dow] || []) {
          assert.ok(s.end <= cs || s.start >= ce, `session ${s.date} ${s.start}-${s.end} overlaps class ${cs}-${ce}`)
        }
        // never overlaps another supervisor's session on the same date
        byDate[s.date] = byDate[s.date] || []
        for (const [os, oe] of byDate[s.date]) {
          assert.ok(s.end <= os || s.start >= oe, `cross-supervisor overlap on ${s.date}`)
        }
        byDate[s.date].push([s.start, s.end])
        weekMin += s.end - s.start
      }
      assert.equal(weekMin % 60, 0, 'weekly total is whole hours')
      assert.equal(weekMin / 60, 9, `${supervisor} week ${wi + 1} hits the 9h target`)
      total += weekMin
    })
    assert.equal(total / 60, 36, 'monthly total')
  }

  /* ---------------- bill generation ---------------- */
  const billRes = await fetch(`${BASE}/api/generate-bills`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...body,
      name: 'Test Student',
      id: '2311249',
      bankaccnum: '1234567890',
      phoneNumber: '01712345678',
    }),
  })
  const bills = await billRes.json()
  assert.equal(bills.success, true, JSON.stringify(bills))
  assert.equal(bills.bills.length, 2)

  for (const bill of bills.bills) {
    assert.match(bill.filename, /^SoD_Bill_Test_Student_.+_June_2026\.docx$/)
    const zip = new PizZip(Buffer.from(bill.buffer, 'base64'))
    // scan every xml part: fields live in the body AND the page header
    const all = Object.keys(zip.files)
      .filter((n) => n.endsWith('.xml'))
      .map((n) => zip.file(n).asText())
      .join('\n')
    assert.ok(!all.includes('{{'), `leftover template tags in ${bill.filename}`)
    assert.ok(all.includes('Test Student'), 'student name filled')
    assert.ok(all.includes('June'), 'month filled (header part)')
  }

  /* ---------------- shared week-dates store ---------------- */
  const saveRes = await fetch(`${BASE}/api/week-dates`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      year: 2026,
      month: 6,
      // 45 is out of range for June, 'x' is junk, 2 repeats week 1: all cleaned
      weekDates: { 1: [2, 1], 2: [8, 45, 'x'], 3: [], 4: [2, 30] },
    }),
  })
  assert.equal((await saveRes.json()).success, true)

  const got = await (await fetch(`${BASE}/api/week-dates/2026/6`)).json()
  assert.equal(got.found, true)
  assert.ok(got.updatedAt, 'updatedAt recorded')
  assert.deepEqual(got.weekDates, { 1: [1, 2], 2: [8], 3: [], 4: [30] })

  const miss = await (await fetch(`${BASE}/api/week-dates/2031/2`)).json()
  assert.equal(miss.found, false)

  const badSave = await fetch(`${BASE}/api/week-dates`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ year: 2026, month: 13, weekDates: { 1: [1] } }),
  })
  assert.equal(badSave.status, 400, 'month 13 must be rejected')

  /* ---------------- validation errors ---------------- */
  const bad = await fetch(`${BASE}/api/generate-schedule`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, supervisors: [{ name: 'X', hoursPerWeek: 25 }] }),
  })
  assert.ok(!bad.ok || (await bad.json()).success === false, '25h/week must be rejected')

  console.log('ok - server e2e passed (schedule rules, 2 bills, no leftover tags, shared dates store)')
} finally {
  server.kill()
}
