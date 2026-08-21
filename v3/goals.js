/* ─── 🎯 Goal Tracker (V3.0) ───────────────────────────────────────────────
   GET    /api/v3/goals          — every goal with live progress
   POST   /api/v3/goals          — create
   PUT    /api/v3/goals/:id      — edit
   DELETE /api/v3/goals/:id      — remove

   Set a target ("£600 for a new bike", "200 hours this year") and this works out
   where you are against it from your real shifts, how fast you're going, and
   whether the deadline is realistic — projecting the finish date from your
   actual recent earning rate rather than an assumed one.
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');
const {
  db, localDateStr, addDays, daysBetween, paidHours, shiftPay, round1, round2, clamp,
} = require('./helpers');
require('./schema');

const router = express.Router();

const GOAL_TYPES = ['money', 'hours', 'shifts'];

/** How much of a goal a set of shifts contributes, per goal type. */
function contribution(shifts, type) {
  if (type === 'hours')  return round1(shifts.reduce((t, s) => t + paidHours(s), 0));
  if (type === 'shifts') return shifts.length;
  return round2(shifts.reduce((t, s) => t + (shiftPay(s) || 0), 0));
}

function decorate(goal) {
  const today = localDateStr();

  // Progress counts shifts from the goal's start date up to today. Future rota
  // entries are counted separately as "already booked in" so you can see whether
  // the shifts you're scheduled for will get you there without any extra work.
  const banked = db.prepare(
    'SELECT * FROM shifts WHERE date >= ? AND date <= ? ORDER BY date ASC'
  ).all(goal.start_date, today);

  const scheduled = goal.target_date
    ? db.prepare('SELECT * FROM shifts WHERE date > ? AND date <= ? ORDER BY date ASC').all(today, goal.target_date)
    : db.prepare('SELECT * FROM shifts WHERE date > ? ORDER BY date ASC').all(today);

  const progress   = contribution(banked, goal.goal_type);
  const upcoming   = contribution(scheduled, goal.goal_type);
  const remaining  = Math.max(0, round2(goal.target - progress));
  const progressPct = goal.target > 0 ? clamp(round1((progress / goal.target) * 100), 0, 100) : 0;

  // Rate of progress, measured over the goal's own lifetime so far (min 1 day).
  const daysElapsed = Math.max(1, daysBetween(goal.start_date, today));
  const perDay = progress / daysElapsed;

  // Projected finish: extend the current rate forwards. Only meaningful once
  // there's actual movement — a goal with zero progress has no trend to project.
  let projected_date = null, projected_days = null;
  if (remaining > 0 && perDay > 0) {
    projected_days = Math.ceil(remaining / perDay);
    projected_date = addDays(today, projected_days);
  } else if (remaining <= 0) {
    projected_days = 0;
    projected_date = today;
  }

  const daysLeft = goal.target_date ? daysBetween(today, goal.target_date) : null;
  // "On track" compares where you are against where a straight line from start
  // to deadline says you should be by now.
  let on_track = null, expected_pct = null;
  if (goal.target_date) {
    const totalDays = Math.max(1, daysBetween(goal.start_date, goal.target_date));
    expected_pct = clamp(round1((daysElapsed / totalDays) * 100), 0, 100);
    on_track = progressPct >= expected_pct - 0.05 || remaining <= 0;
  }

  // Shifts still needed, using your average contribution per shift so far.
  const perShift = banked.length ? progress / banked.length : 0;
  const shifts_needed = remaining > 0 && perShift > 0 ? Math.ceil(remaining / perShift) : 0;

  return {
    ...goal,
    progress,
    remaining,
    progress_pct: progressPct,
    expected_pct,
    on_track,
    days_elapsed: daysElapsed,
    days_left: daysLeft,
    per_day: goal.goal_type === 'money' ? round2(perDay) : round1(perDay),
    per_shift: goal.goal_type === 'money' ? round2(perShift) : round1(perShift),
    shifts_needed,
    scheduled_ahead: upcoming,
    // Will the rota you already have booked in carry you over the line?
    covered_by_scheduled: remaining <= 0 ? true : upcoming >= remaining,
    projected_date,
    projected_days,
    complete: remaining <= 0,
  };
}

router.get('/goals', (req, res) => {
  const includeArchived = req.query.archived === '1';
  const rows = db.prepare(
    `SELECT * FROM v3_goals ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY archived ASC, id DESC`
  ).all();
  res.json({ goals: rows.map(decorate), today: localDateStr() });
});

router.post('/goals', (req, res) => {
  const { title, goal_type = 'money', target, start_date, target_date } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'title is required' });
  if (!GOAL_TYPES.includes(goal_type)) return res.status(400).json({ error: 'goal_type must be money, hours or shifts' });
  const amount = parseFloat(target);
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'target must be a positive number' });

  const start = start_date || localDateStr();
  if (target_date && target_date < start) {
    return res.status(400).json({ error: 'target_date cannot be before start_date' });
  }

  const info = db.prepare(
    'INSERT INTO v3_goals (title, goal_type, target, start_date, target_date) VALUES (?,?,?,?,?)'
  ).run(String(title).trim(), goal_type, amount, start, target_date || null);

  res.status(201).json(decorate(db.prepare('SELECT * FROM v3_goals WHERE id = ?').get(info.lastInsertRowid)));
});

router.put('/goals/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM v3_goals WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Goal not found' });

  const { title, goal_type, target, start_date, target_date, archived } = req.body || {};
  if (goal_type !== undefined && !GOAL_TYPES.includes(goal_type)) {
    return res.status(400).json({ error: 'goal_type must be money, hours or shifts' });
  }
  const amount = target !== undefined ? parseFloat(target) : existing.target;
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'target must be a positive number' });

  const merged = {
    title:       title !== undefined ? String(title).trim() : existing.title,
    goal_type:   goal_type !== undefined ? goal_type : existing.goal_type,
    target:      amount,
    start_date:  start_date !== undefined ? start_date : existing.start_date,
    target_date: target_date !== undefined ? (target_date || null) : existing.target_date,
    archived:    archived !== undefined ? (archived ? 1 : 0) : existing.archived,
  };
  if (merged.target_date && merged.target_date < merged.start_date) {
    return res.status(400).json({ error: 'target_date cannot be before start_date' });
  }

  db.prepare(`UPDATE v3_goals SET title = ?, goal_type = ?, target = ?, start_date = ?, target_date = ?, archived = ?
              WHERE id = ?`).run(merged.title, merged.goal_type, merged.target, merged.start_date,
                                 merged.target_date, merged.archived, req.params.id);

  res.json(decorate(db.prepare('SELECT * FROM v3_goals WHERE id = ?').get(req.params.id)));
});

router.delete('/goals/:id', (req, res) => {
  const info = db.prepare('DELETE FROM v3_goals WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Goal not found' });
  res.json({ deleted: true });
});

module.exports = router;
