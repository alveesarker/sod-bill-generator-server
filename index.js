import express from 'express'
import cors from 'cors'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import PizZip from 'pizzip'
import Docxtemplater from 'docxtemplater'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATE_PATH = path.join(__dirname, 'templates', 'sod-template.docx')
const DATA_DIR = path.join(__dirname, 'data')
const SHARED_DATES_PATH = path.join(DATA_DIR, 'shared-dates.json')

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors())
app.use(express.json({ limit: '10mb' }))

/* ────────────────────────── constants ────────────────────────── */

// Duty may only be scheduled inside the working day.
const DAY_START = 8 * 60 // 08:00
const DAY_END = 18 * 60 // 18:00
const MIN_SESSION_MIN = 60 // no session shorter than 1 hour
const SNAP_MIN = 30 // sessions start on the half hour
const MAX_COMBINED_WEEKLY = 20 // all supervisors together, per week

// University day codes → JS weekday numbers (0 = Sunday).
const DAY_CODES = {
  S: [0],
  M: [1],
  T: [2],
  W: [3],
  R: [4],
  F: [5],
  A: [6],
  MW: [1, 3],
  ST: [0, 2],
  AR: [6, 4],
}

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

/* ────────────────────────── small helpers ────────────────────────── */

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number)
  return h * 60 + m
}

function toClock12(mins) {
  const h24 = Math.floor(mins / 60)
  const m = mins % 60
  const suffix = h24 >= 12 ? 'PM' : 'AM'
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`
}

function formatDMY(year, month, day) {
  const dd = String(day).padStart(2, '0')
  const mm = String(month).padStart(2, '0')
  return `${dd}/${mm}/${year}`
}

function weekdayOf(year, month, day) {
  return new Date(year, month - 1, day).getDay()
}

/* ────────────────────────── conflict windows ────────────────────────── */

/**
 * Turn the class list into blocked time windows keyed by weekday.
 * Each course may map to one or two weekdays depending on its day code.
 */
function buildConflictMap(courses) {
  const map = {}
  for (const course of courses || []) {
    if (!course || !course.dayCode || !course.startTime || !course.endTime) continue
    for (const wd of DAY_CODES[course.dayCode] || []) {
      if (!map[wd]) map[wd] = []
      map[wd].push({ start: toMinutes(course.startTime), end: toMinutes(course.endTime) })
    }
  }
  return map
}

/**
 * Free windows inside the working day for a given weekday, after removing
 * every class window. Windows shorter than one hour are discarded.
 */
function freeWindows(weekday, conflictMap) {
  const blocked = [...(conflictMap[weekday] || [])].sort((a, b) => a.start - b.start)
  const windows = []
  let cursor = DAY_START

  for (const b of blocked) {
    if (b.start > cursor) {
      windows.push({ start: cursor, end: Math.min(b.start, DAY_END) })
    }
    if (b.end > cursor) cursor = b.end
  }
  if (cursor < DAY_END) windows.push({ start: cursor, end: DAY_END })

  return windows.filter((w) => w.end - w.start >= MIN_SESSION_MIN)
}

/* ────────────────────────── week planner ────────────────────────── */

function overlaps(a, b) {
  return a.start < b.end && b.start < a.end
}

/**
 * Candidate durations for one window, longest first. Whole hours are
 * preferred; each whole hour is followed by its half-hour variant so the
 * planner can top a week up to a fractional remainder when needed.
 */
function candidateDurations(remaining, windowMinutes) {
  const out = []
  let d = Math.min(remaining, Math.floor(windowMinutes / 60))
  while (d >= 1) {
    out.push(d)
    const half = d - 0.5
    if (half >= 1 && half <= remaining) out.push(half)
    d -= 1
  }
  return out
}

/**
 * Fill one week for one supervisor.
 *
 * Walks the week's eligible dates in ascending order and greedily books
 * sessions into free windows, always avoiding class times and any session
 * already booked on the same date (whether for this supervisor or another
 * one). Start times snap forward to the nearest half hour.
 *
 * Weekly totals must land on whole hours: if the week ends on a half hour,
 * the final session is stretched by 30 minutes when its window allows it,
 * otherwise that session is dropped.
 */
function planWeek({ year, month, dates, targetHours, conflictMap, bookedByDate }) {
  const sessions = []
  let total = 0

  for (const dateNum of [...dates].sort((a, b) => a - b)) {
    if (total >= targetHours) break

    const weekday = weekdayOf(year, month, dateNum)
    const windows = freeWindows(weekday, conflictMap).map((w) => ({ ...w }))
    if (windows.length === 0) continue

    const busy = [
      ...(bookedByDate.get(dateNum) || []),
      ...sessions.filter((s) => s.date === dateNum),
    ]

    for (const win of windows) {
      if (total >= targetHours) break
      const remaining = targetHours - total

      for (const dur of candidateDurations(remaining, win.end - win.start)) {
        if (total + dur > targetHours + 0.01) continue

        const start = Math.ceil(win.start / SNAP_MIN) * SNAP_MIN
        const end = start + dur * 60
        if (end > win.end) continue

        const clash = busy.some((b) => overlaps({ start, end }, b))
        if (clash) continue

        const session = { date: dateNum, dayOfWeek: weekday, start, end, durationHours: dur }
        sessions.push(session)
        busy.push(session)
        total += dur
        win.start = end
        break // one session per window
      }
    }
  }

  // Force the weekly total onto a whole hour.
  if (total % 1 !== 0 && sessions.length > 0) {
    const last = sessions[sessions.length - 1]
    if (last.durationHours % 1 !== 0) {
      const windows = freeWindows(last.dayOfWeek, conflictMap)
      const host = windows.find((w) => w.start <= last.start && w.end >= last.end + SNAP_MIN)
      const wouldClash = (bookedByDate.get(last.date) || []).some((b) =>
        overlaps({ start: last.start, end: last.end + SNAP_MIN }, b)
      )
      if (host && !wouldClash) {
        last.end += SNAP_MIN
        last.durationHours += 0.5
        total += 0.5
      } else {
        total -= last.durationHours
        sessions.pop()
      }
    }
    total = Math.floor(total)
  }

  return { sessions, hours: Math.round(total) }
}

/**
 * Plan every supervisor for the month. Supervisors are processed in order,
 * so the first supervisor gets first choice of the free time. A shared
 * per-date booking index guarantees no two bills ever overlap, and shared
 * weekly counters enforce the combined 20-hour weekly ceiling.
 */
function badRequest(message) {
  const err = new Error(message)
  err.status = 400
  return err
}

// Reject malformed requests outright instead of silently clamping — the
// client enforces the same rules in the wizard, so anything failing here
// came from outside the app.
function validateRequest({ year, month, weekDates, supervisors, courses }) {
  if (!Number.isInteger(year) || year < 1970 || year > 2100) {
    throw badRequest('year must be a four-digit year')
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw badRequest('month must be 1-12')
  }
  if (!Array.isArray(weekDates)) throw badRequest('weekDates must be an array of 4 arrays')
  if (!Array.isArray(supervisors) || supervisors.length === 0) {
    throw badRequest('at least one supervisor is required')
  }
  let combined = 0
  for (const sup of supervisors) {
    if (!sup || !String(sup.name || '').trim()) throw badRequest('supervisor name is required')
    const hours = Number(sup.hoursPerWeek)
    if (!Number.isFinite(hours) || hours < 1) {
      throw badRequest('hoursPerWeek must be at least 1')
    }
    combined += hours
  }
  if (combined > MAX_COMBINED_WEEKLY) {
    throw badRequest(`combined weekly hours (${combined}) exceed the ${MAX_COMBINED_WEEKLY}h ceiling`)
  }
  for (const c of courses || []) {
    if (!DAY_CODES[c.dayCode]) throw badRequest(`unknown day code: ${c.dayCode}`)
    if (!(toMinutes(c.startTime) < toMinutes(c.endTime))) {
      throw badRequest('course end time must be after start time')
    }
  }
}

function planMonth({ year, month, weekDates, supervisors, courses }) {
  validateRequest({ year, month, weekDates, supervisors, courses })
  const conflictMap = buildConflictMap(courses)
  const combinedWeekly = [0, 0, 0, 0]
  const bookedByDate = new Map()

  const results = []

  for (const sup of supervisors || []) {
    const weeks = [[], [], [], []]

    for (let wk = 0; wk < 4; wk++) {
      const dates = (weekDates && weekDates[wk]) || []
      const target = Math.min(
        Number(sup.hoursPerWeek) || 0,
        MAX_COMBINED_WEEKLY - combinedWeekly[wk]
      )
      if (dates.length === 0 || target <= 0) continue

      const plan = planWeek({ year, month, dates, targetHours: target, conflictMap, bookedByDate })

      weeks[wk] = plan.sessions
      combinedWeekly[wk] += plan.hours
      for (const s of plan.sessions) {
        if (!bookedByDate.has(s.date)) bookedByDate.set(s.date, [])
        bookedByDate.get(s.date).push(s)
      }
    }

    results.push({ supervisor: sup.name, schedule: { weeks } })
  }

  return results
}

/* ────────────────────────── template data ────────────────────────── */

const ROWS_PER_WEEK = 7 // the printed form has seven rows per week

/**
 * Flatten one supervisor's schedule into the flat tag map the Word
 * template expects: per-cell tags for every row of the four weekly
 * blocks, weekly totals, and the monthly total.
 */
function buildTemplateData({ student, supervisorName, schedule, year, monthNumber }) {
  const data = {
    name: student.name || '',
    id: student.id || '',
    bankaccnum: student.bankaccnum || '',
    phoneNumber: student.phoneNumber || '',
    month: MONTH_NAMES[monthNumber - 1] || '',
    year: String(year),
    supervisor: supervisorName || '',
  }

  let monthlyTotal = 0

  for (let wk = 0; wk < 4; wk++) {
    const sessions = schedule.weeks[wk] || []
    let weekTotal = 0

    for (let row = 0; row < ROWS_PER_WEEK; row++) {
      const key = `${wk + 1}${row + 1}`
      const s = sessions[row]

      if (s) {
        data[`date${key}`] = formatDMY(year, monthNumber, s.date)
        data[`day${key}`] = DAY_NAMES[s.dayOfWeek]
        data[`strtTime${key}`] = toClock12(s.start)
        data[`endTime${key}`] = toClock12(s.end)
        data[`dth${key}`] =
          s.durationHours % 1 === 0 ? String(s.durationHours) : s.durationHours.toFixed(1)
        weekTotal += s.durationHours
      } else {
        data[`date${key}`] = ''
        data[`day${key}`] = ''
        data[`strtTime${key}`] = ''
        data[`endTime${key}`] = ''
        data[`dth${key}`] = ''
      }
    }

    const rounded = Math.round(weekTotal)
    data[`wth${wk + 1}`] = rounded > 0 ? String(rounded) : ''
    monthlyTotal += rounded
  }

  data.mth = monthlyTotal > 0 ? String(monthlyTotal) : ''
  return data
}

function renderBill(templateBinary, data) {
  const zip = new PizZip(templateBinary)
  const doc = new Docxtemplater(zip, {
    delimiters: { start: '{{', end: '}}' },
  })
  doc.render(data)
  return doc.getZip().generate({ type: 'nodebuffer' })
}

function safeFilePart(text) {
  return String(text || '').trim().replace(/\s+/g, '_')
}

/* ────────────────── shared week-dates store ────────────────── */

// Every SoD student receives the same departmental announcement, so week
// dates extracted from an uploaded screenshot are stored per month and
// offered to everyone else. Plain JSON file — no database to operate.
// On hosts with an ephemeral filesystem (e.g. Render's free tier) the
// store resets when the instance is replaced; the next screenshot upload
// simply refills it.
function readSharedDates() {
  try {
    return JSON.parse(fs.readFileSync(SHARED_DATES_PATH, 'utf8'))
  } catch {
    return {}
  }
}

function writeSharedDates(all) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const tmp = `${SHARED_DATES_PATH}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2))
  fs.renameSync(tmp, SHARED_DATES_PATH)
}

// Keep only plausible day numbers for that month; a day may appear in one
// week only. Returns null when nothing valid remains.
function cleanWeekDates(weekDates, year, month) {
  if (!weekDates || typeof weekDates !== 'object') return null
  const maxDay = new Date(year, month, 0).getDate()
  const out = {}
  const seen = new Set()
  let total = 0
  for (let w = 1; w <= 4; w++) {
    const days = Array.isArray(weekDates[w]) ? weekDates[w] : []
    out[w] = []
    for (const d of days) {
      const day = Number(d)
      if (!Number.isInteger(day) || day < 1 || day > maxDay || seen.has(day)) continue
      seen.add(day)
      out[w].push(day)
    }
    out[w].sort((a, b) => a - b)
    total += out[w].length
  }
  return total > 0 ? out : null
}

/* ────────────────────────── routes ────────────────────────── */

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'SoD Bill Generator API' })
})

app.get('/api/week-dates/:year/:month', (req, res) => {
  const year = Number(req.params.year)
  const month = Number(req.params.month)
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return res.status(400).json({ success: false, error: 'bad year or month' })
  }
  const entry = readSharedDates()[`${year}-${month}`]
  res.json({ success: true, found: Boolean(entry), ...(entry || {}) })
})

app.post('/api/week-dates', (req, res) => {
  try {
    const { year, month, weekDates } = req.body
    if (!Number.isInteger(year) || year < 1970 || year > 2100) {
      throw badRequest('year must be a four-digit year')
    }
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw badRequest('month must be 1-12')
    }
    const cleaned = cleanWeekDates(weekDates, year, month)
    if (!cleaned) throw badRequest('weekDates must assign at least one valid day to weeks 1-4')
    const all = readSharedDates()
    all[`${year}-${month}`] = { weekDates: cleaned, updatedAt: new Date().toISOString() }
    writeSharedDates(all)
    res.json({ success: true })
  } catch (err) {
    if (!err.status) console.error(err)
    res.status(err.status || 500).json({ success: false, error: err.message })
  }
})

app.post('/api/generate-schedule', (req, res) => {
  try {
    const { year, month, weekDates, supervisors, courses } = req.body
    const results = planMonth({ year, month, weekDates, supervisors, courses })
    res.json({ success: true, results })
  } catch (err) {
    if (!err.status) console.error(err)
    res.status(err.status || 500).json({ success: false, error: err.message })
  }
})

app.post('/api/generate-bills', (req, res) => {
  try {
    const {
      name,
      id,
      bankaccnum,
      phoneNumber,
      year,
      month: monthNumber,
      weekDates,
      supervisors,
      courses,
    } = req.body

    const templateBinary = fs.readFileSync(TEMPLATE_PATH, 'binary')
    const results = planMonth({ year, month: monthNumber, weekDates, supervisors, courses })

    const student = { name, id, bankaccnum, phoneNumber }
    const monthName = MONTH_NAMES[monthNumber - 1]

    const bills = results.map(({ supervisor, schedule }) => {
      const data = buildTemplateData({
        student,
        supervisorName: supervisor,
        schedule,
        year,
        monthNumber,
      })
      const buffer = renderBill(templateBinary, data)
      const filename = `SoD_Bill_${safeFilePart(name)}_${safeFilePart(supervisor)}_${monthName}_${year}.docx`
      return { filename, supervisor, buffer: buffer.toString('base64') }
    })

    res.json({ success: true, bills })
  } catch (err) {
    if (!err.status) console.error(err)
    res.status(err.status || 500).json({ success: false, error: err.message })
  }
})

app.listen(PORT, () => {
  console.log(`SoD Bill Generator server listening on port ${PORT}`)
})
