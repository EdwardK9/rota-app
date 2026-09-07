/* ─── Clopening & Fatigue Audit (V2.0 Phase 4.1) ────────────────────────────
   Endpoint:
     GET /api/fatigue-audit?week=YYYY-MM-DD  — any date in the target Mon–Sun week

   Runs three rule-based checks over the imported team calendar (colleague_shifts):
     - Clopening: less than 11h rest between the end of one working day and the
       start of the next (real-time shifts only — "all_day" entries don't carry
       exact times, so they're skipped for this specific check).
     - Consecutive days: 6+ calendar days in a row with a working shift.
     - Overtime: hourly colleagues scheduled over their contracted weekly hours,
       checked for the target week before it plays out.
   Scoped to colleagues (the imported team calendar) — not your own shifts,
   which already have their own overtime view elsewhere in the app.
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');
const { db, contractHoursForColleagueOnDate } = require('./db');
const router = express.Router();

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

const toMins = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const pad = n => String(n).padStart(2, '0');
const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (dateStr, n) => { const d = new Date(dateStr + 'T00:00:00'); d.setDate(d.getDate() + n); return fmt(d); };

/** Hours worked for a colleague_shifts row (see teamMetrics.js for the same
 *  convention — "all_day" rows use the hours_per_day setting as a stand-in). */
function shiftHours(row, hoursPerDay) {
  if (row.shift_type === 'all_day') return hoursPerDay;
  let mins = toMins(row.end_time) - toMins(row.start_time);
  if (mins <= 0) mins += 24 * 60;
  return mins / 60;
}

const MIN_REST_HOURS = 11;
const MIN_STREAK_DAYS = 6;

router.get('/fatigue-audit', (req, res) => {
  const weekParam = req.query.week || new Date().toISOString().slice(0, 10);
  const anchor = new Date(weekParam + 'T00:00:00');
  if (isNaN(anchor.getTime())) return res.status(400).json({ error: 'invalid week date' });

  const dow = (anchor.getDay() + 6) % 7; // Mon=0 ... Sun=6
  const monday = new Date(anchor); monday.setDate(anchor.getDate() - dow);
  const mondayStr = fmt(monday);
  const sundayStr = addDays(mondayStr, 6);

  // Wider window so streaks/clopening pairs that straddle the week boundary
  // (e.g. a run of shifts starting the week before) are still caught.
  const windowFrom = addDays(mondayStr, -7);
  const windowTo   = addDays(sundayStr, 1);

  const hoursPerDay = parseFloat(getSetting('hours_per_day', '7.4')) || 7.4;
  const referenceDate = mondayStr;
  const colleagues = db.prepare('SELECT * FROM colleagues ORDER BY sort_order ASC, name ASC').all()
    .filter(c => (!c.left_date || c.left_date >= referenceDate) && (!c.start_date || c.start_date <= sundayStr));

  const allShifts = db.prepare(`
    SELECT * FROM colleague_shifts
    WHERE date >= ? AND date <= ? AND shift_type != 'leave'
    ORDER BY date ASC, start_time ASC
  `).all(windowFrom, windowTo);

  const results = colleagues.map(c => {
    const shifts = allShifts.filter(s => s.colleague_id === c.id);

    // Group by date (a colleague can have more than one shift a day — a split shift)
    const byDate = new Map();
    for (const s of shifts) {
      if (!byDate.has(s.date)) byDate.set(s.date, []);
      byDate.get(s.date).push(s);
    }
    const workDates = [...byDate.keys()].sort();

    // ── Clopening: check every adjacent pair of calendar days ──────────────
    const clopening = [];
    for (const d of workDates) {
      const next = addDays(d, 1);
      if (!byDate.has(next)) continue;
      const todays = byDate.get(d).filter(s => s.shift_type === 'shift');
      const nextDays = byDate.get(next).filter(s => s.shift_type === 'shift');
      if (!todays.length || !nextDays.length) continue; // can't compute exact rest for all_day entries
      // Last shift to end today, first shift to start tomorrow
      const lastEnd = todays.reduce((latest, s) => toMins(s.end_time) > toMins(latest.end_time) ? s : latest);
      const firstStart = nextDays.reduce((earliest, s) => toMins(s.start_time) < toMins(earliest.start_time) ? s : earliest);
      const endMins = toMins(lastEnd.end_time);
      const restMins = (24 * 60 - endMins) + toMins(firstStart.start_time);
      const restHours = Math.round((restMins / 60) * 10) / 10;
      if (restHours < MIN_REST_HOURS && (next >= mondayStr && next <= windowTo)) {
        clopening.push({
          date: next, rest_hours: restHours,
          previous: { date: d, end_time: lastEnd.end_time },
          next: { date: next, start_time: firstStart.start_time },
        });
      }
    }

    // ── Consecutive working days ────────────────────────────────────────────
    const streaks = [];
    let streakStart = null, prevDate = null;
    const flushStreak = (endDate) => {
      if (streakStart == null) return;
      const len = (new Date(endDate + 'T00:00:00') - new Date(streakStart + 'T00:00:00')) / 86400000 + 1;
      if (len >= MIN_STREAK_DAYS && endDate >= mondayStr) {
        streaks.push({ start_date: streakStart, end_date: endDate, length: len });
      }
    };
    for (const d of workDates) {
      if (prevDate && addDays(prevDate, 1) === d) {
        // streak continues
      } else {
        flushStreak(prevDate);
        streakStart = d;
      }
      prevDate = d;
    }
    flushStreak(prevDate);

    // ── Overtime (hourly colleagues only, target week) ──────────────────────
    let overtime = null;
    const weekContractHours = c.pay_type !== 'salaried' ? contractHoursForColleagueOnDate(c.id, mondayStr) : 0;
    if (c.pay_type !== 'salaried' && weekContractHours) {
      const weekHours = allShifts
        .filter(s => s.colleague_id === c.id && s.date >= mondayStr && s.date <= sundayStr)
        .reduce((t, s) => t + shiftHours(s, hoursPerDay), 0);
      const scheduledHours = Math.round(weekHours * 100) / 100;
      if (scheduledHours > weekContractHours) {
        overtime = {
          scheduled_hours: scheduledHours,
          contract_hours: weekContractHours,
          overage: Math.round((scheduledHours - weekContractHours) * 100) / 100,
        };
      }
    }

    return {
      colleague_id: c.id, name: c.name,
      clopening, consecutive_streaks: streaks, overtime,
      flag_count: clopening.length + streaks.length + (overtime ? 1 : 0),
    };
  }).sort((a, b) => b.flag_count - a.flag_count);

  res.json({ week: { from: mondayStr, to: sundayStr }, colleagues: results });
});

/** Reusable flag lookup for an arbitrary date range, used by the Phase 6 CSV
 *  export (kept independent of the /fatigue-audit route above so that route's
 *  already-verified single-week behaviour isn't touched by this).
 *  Returns { [colleague_id]: { name, flagsByDate: { [date]: string[] } } } */
function computeFlagsForRange(fromDate, toDate) {
  const windowFrom = addDays(fromDate, -7);
  const windowTo = addDays(toDate, 1);
  const hoursPerDay = parseFloat(getSetting('hours_per_day', '7.4')) || 7.4;

  const colleagues = db.prepare('SELECT * FROM colleagues').all();
  const allShifts = db.prepare(`
    SELECT * FROM colleague_shifts WHERE date >= ? AND date <= ? AND shift_type != 'leave' ORDER BY date ASC, start_time ASC
  `).all(windowFrom, windowTo);

  const result = {};
  for (const c of colleagues) {
    const shifts = allShifts.filter(s => s.colleague_id === c.id);
    const byDate = new Map();
    for (const s of shifts) { if (!byDate.has(s.date)) byDate.set(s.date, []); byDate.get(s.date).push(s); }
    const workDates = [...byDate.keys()].sort();
    const flagsByDate = {};
    const addFlag = (date, text) => {
      if (date < fromDate || date > toDate) return;
      (flagsByDate[date] || (flagsByDate[date] = [])).push(text);
    };

    // Clopening
    for (const d of workDates) {
      const next = addDays(d, 1);
      if (!byDate.has(next)) continue;
      const todays = byDate.get(d).filter(s => s.shift_type === 'shift');
      const nextDays = byDate.get(next).filter(s => s.shift_type === 'shift');
      if (!todays.length || !nextDays.length) continue;
      const lastEnd = todays.reduce((l, s) => toMins(s.end_time) > toMins(l.end_time) ? s : l);
      const firstStart = nextDays.reduce((e, s) => toMins(s.start_time) < toMins(e.start_time) ? s : e);
      const restMins = (24 * 60 - toMins(lastEnd.end_time)) + toMins(firstStart.start_time);
      const restHours = Math.round((restMins / 60) * 10) / 10;
      if (restHours < MIN_REST_HOURS) addFlag(next, `Clopening (${restHours}h rest)`);
    }

    // Consecutive-day streaks
    let streakStart = null, prevDate = null;
    const flushStreak = (endDate) => {
      if (streakStart == null) return;
      const len = (new Date(endDate + 'T00:00:00') - new Date(streakStart + 'T00:00:00')) / 86400000 + 1;
      if (len >= MIN_STREAK_DAYS) {
        let d = streakStart;
        while (d <= endDate) { addFlag(d, `${len}-day streak`); d = addDays(d, 1); }
      }
    };
    for (const d of workDates) {
      if (prevDate && addDays(prevDate, 1) === d) { /* streak continues */ }
      else { flushStreak(prevDate); streakStart = d; }
      prevDate = d;
    }
    flushStreak(prevDate);

    // Overtime — evaluated per Mon-Sun week overlapping the requested range
    if (c.pay_type !== 'salaried') {
      const weeks = new Set();
      for (const d of workDates) {
        const anchor = new Date(d + 'T00:00:00');
        const wdow = (anchor.getDay() + 6) % 7;
        const wmon = new Date(anchor); wmon.setDate(anchor.getDate() - wdow);
        weeks.add(fmt(wmon));
      }
      for (const monday of weeks) {
        const weekContractHours = contractHoursForColleagueOnDate(c.id, monday);
        if (!weekContractHours) continue;
        const sunday = addDays(monday, 6);
        const weekHours = allShifts
          .filter(s => s.colleague_id === c.id && s.date >= monday && s.date <= sunday)
          .reduce((t, s) => t + shiftHours(s, hoursPerDay), 0);
        if (weekHours > weekContractHours) {
          const label = `Overtime (${Math.round(weekHours * 100) / 100}h/${weekContractHours}h)`;
          for (const d of workDates) { if (d >= monday && d <= sunday) addFlag(d, label); }
        }
      }
    }

    result[c.id] = { name: c.name, flagsByDate };
  }
  return result;
}

module.exports = router;
module.exports.computeFlagsForRange = computeFlagsForRange;
