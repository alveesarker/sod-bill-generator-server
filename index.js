import cors from 'cors';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ─── Day code utilities ────────────────────────────────────────────────────
const DAY_CODE_MAP = {
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
};

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

// Parse class schedule into conflict windows per weekday
function parseClassSchedule(courses) {
  const conflicts = {};

  for (const course of courses) {
    if (!course.dayCode || !course.startTime || !course.endTime) continue;

    const days = DAY_CODE_MAP[course.dayCode] || [];

    for (const d of days) {
      if (!conflicts[d]) conflicts[d] = [];

      conflicts[d].push({
        start: course.startTime,
        end: course.endTime,
      });
    }
  }

  return conflicts;
}

// Convert HH:MM to minutes
function toMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;

  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;

  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

// Get free time slots
function getFreeSlots(dayOfWeek, classConflicts) {
  const WORK_START = 8 * 60;
  const WORK_END = 18 * 60;

  const blocked = (classConflicts[dayOfWeek] || []).map((c) => ({
    start: toMinutes(c.start),
    end: toMinutes(c.end),
  }));

  blocked.sort((a, b) => a.start - b.start);

  const free = [];
  let cursor = WORK_START;

  for (const b of blocked) {
    if (b.start > cursor) {
      free.push({
        start: cursor,
        end: Math.min(b.start, WORK_END),
      });
    }

    cursor = Math.max(cursor, b.end);
  }

  if (cursor < WORK_END) {
    free.push({
      start: cursor,
      end: WORK_END,
    });
  }

  return free.filter((s) => s.end - s.start >= 60);
}

function pickSession(slot, durationHours) {
  const durationMins = durationHours * 60;
  const available = slot.end - slot.start;

  if (available < durationMins) return null;

  let start = slot.start;

  start = Math.ceil(start / 30) * 30;

  if (start + durationMins > slot.end) return null;

  return {
    start,
    end: start + durationMins,
  };
}

function sessionsOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

function getDateObj(year, month, dateNum) {
  return new Date(year, month - 1, dateNum);
}

// ─── Schedule Generator ────────────────────────────────────────────────────
function generateSchedule(params) {
  const {
    year,
    month,
    weekDates,
    supervisorHours,
    classConflicts,
    alreadyScheduled,
    combinedWeekTotals,
    maxCombined,
  } = params;

  const result = {
    weeks: [[], [], [], []],
  };

  for (let wk = 0; wk < 4; wk++) {
    const dates = weekDates[wk] || [];

    if (dates.length === 0) continue;

    const canUseMax = Math.min(
      supervisorHours,
      maxCombined - combinedWeekTotals[wk]
    );

    let targetHours = Math.min(supervisorHours, canUseMax);

    if (targetHours <= 0) continue;

    const sortedDates = [...dates].sort((a, b) => a - b);

    const sessions = [];
    let totalHours = 0;

    for (const dateNum of sortedDates) {
      if (totalHours >= targetHours) break;

      const dateObj = getDateObj(year, month, dateNum);
      const dayOfWeek = dateObj.getDay();

      const freeSlots = getFreeSlots(dayOfWeek, classConflicts);

      if (freeSlots.length === 0) continue;

      const otherOnDay = alreadyScheduled.filter(
        (s) => s.date === dateNum
      );

      const thisWeekOnDay = sessions.filter(
        (s) => s.date === dateNum
      );

      for (const slot of freeSlots) {
        if (totalHours >= targetHours) break;

        const needed = targetHours - totalHours;

        const candidates = [];

        for (
          let d = Math.min(
            needed,
            Math.floor((slot.end - slot.start) / 60)
          );
          d >= 1;
          d--
        ) {
          candidates.push(d);

          if (d - 0.5 >= 1 && d - 0.5 <= needed) {
            candidates.push(d - 0.5);
          }
        }

        for (const dur of candidates) {
          if (totalHours + dur > targetHours + 0.01) continue;

          const sess = pickSession(slot, dur);

          if (!sess) continue;

          const conflict = [...otherOnDay, ...thisWeekOnDay].some((s) =>
            sessionsOverlap(
              {
                start: sess.start,
                end: sess.end,
              },
              s
            )
          );

          if (conflict) continue;

          sessions.push({
            date: dateNum,
            dayOfWeek,
            start: sess.start,
            end: sess.end,
            durationHours: dur,
          });

          totalHours += dur;

          slot.start = sess.end;

          break;
        }
      }
    }

    if (totalHours % 1 !== 0) {
      const lastIdx = sessions.length - 1;

      if (
        lastIdx >= 0 &&
        sessions[lastIdx].durationHours % 1 !== 0
      ) {
        const last = sessions[lastIdx];

        const dateObj = getDateObj(
          year,
          month,
          last.date
        );

        const dayOfWeek = dateObj.getDay();

        const freeSlots = getFreeSlots(
          dayOfWeek,
          classConflicts
        );

        const relevantSlot = freeSlots.find(
          (s) =>
            s.start <= last.start &&
            s.end >= last.end + 30
        );

        if (
          relevantSlot &&
          last.end + 30 <= relevantSlot.end &&
          totalHours + 0.5 <= targetHours + 0.5
        ) {
          sessions[lastIdx].end += 30;
          sessions[lastIdx].durationHours += 0.5;
          totalHours += 0.5;
        } else {
          totalHours -= sessions[lastIdx].durationHours;
          sessions.splice(lastIdx, 1);
        }
      }

      totalHours = Math.floor(totalHours);
    }

    combinedWeekTotals[wk] += totalHours;

    result.weeks[wk] = sessions;
  }

  return result;
}

// ─── Helpers ───────────────────────────────────────────────────────────────
function formatDate(year, month, day) {
  return `${String(day).padStart(2, '0')}/${String(month).padStart(
    2,
    '0'
  )}/${year}`;
}

// ─── Build Placeholder Map ────────────────────────────────────────────────
function buildPlaceholders(params) {
  const {
    name,
    id,
    bankaccnum,
    phoneNumber,
    month,
    year,
    supervisor,
    schedule,
    monthNumber,
  } = params;

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
  ];

  const ph = {
    name: name || '',
    id: id || '',
    bankaccnum: bankaccnum || '',
    phoneNumber: phoneNumber || '',
    month: MONTH_NAMES[monthNumber - 1] || month || '',
    year: String(year),
    supervisor: supervisor || '',
  };

  let mth = 0;

  for (let wk = 0; wk < 4; wk++) {
    const sessions = schedule.weeks[wk] || [];

    let wthTotal = 0;

    for (let row = 0; row < 7; row++) {
      const rowNum = row + 1;
      const key = `${wk + 1}${rowNum}`;

      if (row < sessions.length) {
        const s = sessions[row];

        ph[`date${key}`] = formatDate(
          year,
          monthNumber,
          s.date
        );

        ph[`day${key}`] = DAY_NAMES[s.dayOfWeek];

        ph[`strtTime${key}`] = minutesToTime(s.start);

        ph[`endTime${key}`] = minutesToTime(s.end);

        ph[`dth${key}`] =
          s.durationHours % 1 === 0
            ? String(s.durationHours)
            : s.durationHours.toFixed(1);

        wthTotal += s.durationHours;
      } else {
        ph[`date${key}`] = '';
        ph[`day${key}`] = '';
        ph[`strtTime${key}`] = '';
        ph[`endTime${key}`] = '';
        ph[`dth${key}`] = '';
      }
    }

    const wthInt = Math.round(wthTotal);

    ph[`wth${wk + 1}`] =
      wthInt > 0 ? String(wthInt) : '';

    mth += wthInt;
  }

  ph.mth = mth > 0 ? String(mth) : '';

  return ph;
}

// ─── API Endpoints ────────────────────────────────────────────────────────

// Generate schedules only
app.post('/api/generate-schedule', (req, res) => {
  try {
    const {
      year,
      month: monthNumber,
      weekDates,
      supervisors,
      courses,
    } = req.body;

    const classConflicts = parseClassSchedule(courses || []);

    const combinedWeekTotals = [0, 0, 0, 0];

    const allScheduled = [];

    const results = [];

    for (const sup of supervisors) {
      const alreadyScheduled = [...allScheduled];

      const schedule = generateSchedule({
        year,
        month: monthNumber,
        weekDates,
        supervisorHours: sup.hoursPerWeek,
        classConflicts,
        alreadyScheduled,
        combinedWeekTotals,
        maxCombined: 20,
      });

      for (let wk = 0; wk < 4; wk++) {
        for (const sess of schedule.weeks[wk]) {
          allScheduled.push(sess);
        }
      }

      results.push({
        supervisor: sup.name,
        schedule,
      });
    }

    res.json({
      success: true,
      results,
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// Generate DOCX bills
app.post('/api/generate-bills', async (req, res) => {
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
    } = req.body;

    const PizZip = (await import('pizzip')).default;

    const Docxtemplater = (await import('docxtemplater')).default;

    const templatePath = path.join(
      __dirname,
      'templates',
      'sod-template.docx'
    );

    const content = fs.readFileSync(templatePath, 'binary');

    const classConflicts = parseClassSchedule(courses || []);

    const combinedWeekTotals = [0, 0, 0, 0];

    const allScheduled = [];

    const bills = [];

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
    ];

    for (const sup of supervisors) {
      const alreadyScheduled = [...allScheduled];

      const schedule = generateSchedule({
        year,
        month: monthNumber,
        weekDates,
        supervisorHours: sup.hoursPerWeek,
        classConflicts,
        alreadyScheduled,
        combinedWeekTotals,
        maxCombined: 20,
      });

      for (let wk = 0; wk < 4; wk++) {
        for (const sess of schedule.weeks[wk]) {
          allScheduled.push(sess);
        }
      }

      const placeholders = buildPlaceholders({
        name,
        id,
        bankaccnum,
        phoneNumber,
        month: MONTH_NAMES[monthNumber - 1],
        year,
        supervisor: sup.name,
        schedule,
        monthNumber,
      });

      const zip = new PizZip(content);

      const doc = new Docxtemplater(zip, {
        delimiters: {
          start: '{{',
          end: '}}',
        },
      });

      doc.render(placeholders);

      const buffer = doc
        .getZip()
        .generate({ type: 'nodebuffer' });

      const monthName = MONTH_NAMES[monthNumber - 1];

      const safeName = name.replace(/\s+/g, '_');

      const safeSup = sup.name.replace(/\s+/g, '_');

      const filename = `SoD_Bill_${safeName}_${safeSup}_${monthName}_${year}.docx`;

      bills.push({
        filename,
        buffer: buffer.toString('base64'),
        supervisor: sup.name,
        placeholders,
      });
    }

    res.json({
      success: true,
      bills,
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(
    `SoD Bill Generator server running on port ${PORT}`
  );
});