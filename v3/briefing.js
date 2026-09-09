/* ─── 🎒 Shift Briefing (V3.0) ─────────────────────────────────────────────
   GET /api/v3/briefing[?date=YYYY-MM-DD]

   Everything about your next shift on one card, so you don't have to open four
   views the night before: when it is, who's on with you, what it pays, whether
   it's a delivery day or a bank holiday, how the turnaround from your last
   shift looks, and what the same slot has historically been like.

   Pure aggregation — every number here already exists somewhere else in the
   app. The value is having it in one place at the moment you actually want it.
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');
const {
  db, DAYS, getSetting, localDateStr, parseDate, addDays, daysBetween, mondayOf,
  toMins, spanMins, overlapMins, paidHours, shiftPay, contractHoursForDate, round1, round2,
} = require('./helpers');
const { bankHolidayDates } = require('./bankHolidays');
const { deliveryWindow, DEFAULT_DELIVERY_TIME } = require('../delivery');
const { costSettings, costPerMileFor } = require('./commuteCost');

const router = express.Router();

/** Which weekdays deliveries land on, and at what time, from the schedule history. */
function deliverySchedFor(dateStr) {
  const row = db.prepare(
    'SELECT days, delivery_time FROM delivery_schedules WHERE effective_from <= ? ORDER BY effective_from DESC LIMIT 1'
  ).get(dateStr);
  if (!row || !row.days) return { days: [], time: DEFAULT_DELIVERY_TIME };
  return {
    // Stored as a comma-separated list of day names or indices, depending on age
    days: String(row.days).split(',').map(d => d.trim()).filter(Boolean),
    time: row.delivery_time || DEFAULT_DELIVERY_TIME,
  };
}

router.get('/briefing', async (req, res) => {
  const today = localDateStr();
  const nowMins = new Date().getHours() * 60 + new Date().getMinutes();
  const bhDates = await bankHolidayDates();

  // The shift being briefed: an explicit date, else the next one not yet finished.
  let shift;
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '')) {
    shift = db.prepare('SELECT * FROM shifts WHERE date = ? ORDER BY start_time ASC').get(req.query.date);
  } else {
    shift = db.prepare('SELECT * FROM shifts WHERE date >= ? ORDER BY date ASC, start_time ASC LIMIT 10')
      .all(today)
      .find(s => s.date > today || toMins(s.start_time) + spanMins(s.start_time, s.end_time) > nowMins);
  }

  if (!shift) return res.json({ shift: null, today });

  const dow = parseDate(shift.date).getDay();
  const startMins = toMins(shift.start_time);
  const lengthMins = spanMins(shift.start_time, shift.end_time);

  // ── Who else is on ───────────────────────────────────────────────────────
  const crew = db.prepare(`
    SELECT cs.*, c.name, c.job_tier, c.synergy_rating, c.tags
    FROM colleague_shifts cs JOIN colleagues c ON c.id = cs.colleague_id
    WHERE cs.date = ? AND cs.shift_type = 'shift' AND (cs.store IS NULL OR cs.store = '')
    ORDER BY cs.start_time ASC
  `).all(shift.date)
    .map(cs => ({
      name: cs.name,
      start_time: cs.start_time,
      end_time: cs.end_time,
      job_tier: cs.job_tier,
      synergy_rating: cs.synergy_rating || 0,
      overlap_mins: overlapMins(shift.start_time, shift.end_time, cs.start_time, cs.end_time),
    }))
    .filter(c => c.overlap_mins > 0)
    .sort((a, b) => b.overlap_mins - a.overlap_mins);

  // ── Turnaround from the previous shift ───────────────────────────────────
  const prev = db.prepare(
    'SELECT * FROM shifts WHERE date < ? ORDER BY date DESC, start_time DESC LIMIT 1'
  ).get(shift.date);
  let turnaround = null;
  if (prev) {
    const gapDays = daysBetween(prev.date, shift.date);
    const prevEnd = toMins(prev.start_time) + spanMins(prev.start_time, prev.end_time);
    const hours = ((gapDays * 1440) + startMins - prevEnd) / 60;
    turnaround = {
      hours: round1(hours),
      from: prev.date, finished: prev.end_time,
      tight: hours < 12,
      clopening: hours < 12 && prevEnd >= 19 * 60 && startMins <= 8 * 60,
    };
  }

  // ── How this slot has gone before ────────────────────────────────────────
  // Same weekday and same start time, historically — a useful "what am I in for".
  const past = db.prepare(
    'SELECT * FROM shifts WHERE date < ? AND start_time = ? ORDER BY date DESC'
  ).all(today, shift.start_time)
    .filter(s => parseDate(s.date).getDay() === dow);
  const pastClocks = past.length
    ? db.prepare(
        `SELECT * FROM clock_entries WHERE date IN (${past.map(() => '?').join(',')}) AND clocked_in IS NOT NULL`
      ).all(...past.map(s => s.date))
    : [];
  const breakSkips = past.filter(s => s.break_taken === 'none' || s.break_taken === 'partial').length;

  // ── Week context ─────────────────────────────────────────────────────────
  const weekStart = mondayOf(shift.date);
  const weekShifts = db.prepare('SELECT * FROM shifts WHERE date >= ? AND date <= ?')
    .all(weekStart, addDays(weekStart, 6));
  const weekHours = round1(weekShifts.reduce((t, s) => t + paidHours(s), 0));

  const delivSched = deliverySchedFor(shift.date);
  const dayName = DAYS[dow];
  const isDeliveryDay = delivSched.days.some(d =>
    d.toLowerCase().startsWith(dayName.slice(0, 3).toLowerCase()) || d === String(dow));
  // Whether you're actually on the floor for it, on the same ± 1 hour window
  // Insights counts by — a delivery day you finish before is worth knowing about
  // differently from one you're unloading.
  const delivWindow = deliveryWindow(delivSched.time);
  const onForDelivery = isDeliveryDay
    && shift.start_time <= delivWindow.to && shift.end_time >= delivWindow.from;

  const isBH = !!shift.is_bank_holiday || bhDates.has(shift.date);
  const miles = (shift.distance_miles || 0) * 2;
  // Same fuel/electric + wear-per-mile settings as the Commute Cost view, so
  // the two numbers agree instead of this card doing its own petrol-only sum
  // that ignored electric cars and wear entirely.
  const commuteCfg = costSettings();
  const fuelCost = round2(miles * costPerMileFor(commuteCfg));

  res.json({
    today,
    shift: {
      id: shift.id,
      date: shift.date,
      day_name: dayName,
      days_away: daysBetween(today, shift.date),
      is_today: shift.date === today,
      start_time: shift.start_time,
      end_time: shift.end_time,
      hours: round1(paidHours(shift)),
      length_label: `${Math.floor(lengthMins / 60)}h ${String(lengthMins % 60).padStart(2, '0')}m`,
      break_minutes: shift.break_scheduled_minutes,
      pay: round2(shiftPay(shift) || 0),
      rate: shift.hourly_rate,
      is_bank_holiday: isBH,
      completed: !!shift.completed,
      notes: shift.notes || null,
      opening: startMins <= 7 * 60,
      closing: startMins + lengthMins >= 19 * 60,
    },
    crew,
    crew_summary: {
      count: crew.length,
      full_shift: crew.filter(c => c.overlap_mins >= lengthMins - 15).length,
      best_synergy: crew.filter(c => c.synergy_rating > 0).map(c => c.name),
      difficult: crew.filter(c => c.synergy_rating < 0).map(c => c.name),
      alone: crew.length === 0,
    },
    turnaround,
    delivery: {
      is_delivery_day: isDeliveryDay,
      time: isDeliveryDay ? delivSched.time : null,
      on_shift: onForDelivery,
    },
    // Kept for older clients that read the flat flag
    delivery_day: isDeliveryDay,
    commute: { miles: round1(miles), fuel_cost: fuelCost },
    week: {
      start: weekStart,
      shifts: weekShifts.length,
      hours: weekHours,
      contracted: contractHoursForDate(weekStart),
    },
    history: {
      slot: `${dayName} ${shift.start_time}`,
      times_worked: past.length,
      avg_clock_in_diff: pastClocks.length
        ? round1(pastClocks.reduce((t, c) => t + (toMins(shift.start_time) - toMins(c.clocked_in)), 0) / pastClocks.length)
        : null,
      break_skip_rate: past.length ? Math.round((breakSkips / past.length) * 100) : null,
      note: past.length
        ? `You've worked this exact slot ${past.length} time${past.length === 1 ? '' : 's'} before.`
        : 'This is a new slot for you.',
    },
    employer: getSetting('employer', 'work'),
  });
});

module.exports = router;
