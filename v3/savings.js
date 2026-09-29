/* ─── 🐖 Savings & Share Plans (V3.0) ─────────────────────────────────────
   GET    /api/v3/savings          — every plan with live progress
   POST   /api/v3/savings          — create
   PUT    /api/v3/savings/:id      — edit
   DELETE /api/v3/savings/:id      — remove

   A tracker you name yourself for anything that is paid in month after month
   towards a payout: a Sharesave, a Christmas club, a holiday pot. Give it a
   monthly payment and a length and it works out how far in you are, what the
   pot will be at the end and when.

   A "share plan" adds the bit a Sharesave has: the fixed option price you can
   buy shares at when it matures. From that it works out how many shares the
   pot buys, what they are worth at today's share price, and so whether buying
   beats just taking the cash out.

   "How far in you are" can come from three places, because real schemes differ:
     schedule  — one payment on each monthly date since the start (the default)
     payslips  — what your payslips actually show deducted as Sharesave
     manual    — a number of payments you type in yourself
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');
const { db, localDateStr, daysBetween, round1, round2, clamp } = require('./helpers');
require('./schema');

const router = express.Router();

const KINDS = ['savings', 'shares'];
const COUNT_MODES = ['schedule', 'payslips', 'manual'];

/** Same day-of-month `n` months on, clamped for short months (31 Jan + 1 → 28/29 Feb). */
function addMonths(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const total = (m - 1) + n;
  const ny = y + Math.floor(total / 12);
  const nm = ((total % 12) + 12) % 12;
  const last = new Date(ny, nm + 1, 0).getDate();
  return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

function decorate(plan) {
  const today = localDateStr();
  const duration = plan.duration_months;
  const target = round2(plan.monthly_amount * duration);
  const maturityValue = round2(target + (plan.bonus || 0));
  const maturityDate = addMonths(plan.start_date, duration);

  // ── Payments made so far ────────────────────────────────────────────────
  let paidMonths, saved, basis;
  if (plan.count_mode === 'manual') {
    paidMonths = clamp(plan.manual_paid_months || 0, 0, duration);
    saved = round2(paidMonths * plan.monthly_amount);
    basis = 'manual';
  } else if (plan.count_mode === 'payslips') {
    const endMonth = maturityDate.slice(0, 7);
    const rows = db.prepare(
      `SELECT month, sharesave_amount FROM payslips
       WHERE month >= ? AND month < ? AND sharesave_amount > 0 ORDER BY month ASC`
    ).all(plan.start_date.slice(0, 7), endMonth);
    paidMonths = Math.min(duration, rows.length);
    saved = round2(rows.reduce((t, r) => t + r.sharesave_amount, 0));
    basis = 'payslips';
  } else {
    paidMonths = 0;
    for (let i = 0; i < duration; i++) {
      if (addMonths(plan.start_date, i) <= today) paidMonths++;
    }
    saved = round2(paidMonths * plan.monthly_amount);
    basis = 'schedule';
  }

  const remainingMonths = Math.max(0, duration - paidMonths);
  const remaining = Math.max(0, round2(target - saved));
  const progressPct = target > 0 ? clamp(round1((saved / target) * 100), 0, 100) : 0;
  const nextPayment = remainingMonths > 0 ? addMonths(plan.start_date, paidMonths) : null;
  const daysToMaturity = daysBetween(today, maturityDate);
  const started = plan.start_date <= today;
  const matured = maturityDate <= today;

  const out = {
    ...plan,
    target, maturity_value: maturityValue, maturity_date: maturityDate,
    paid_months: paidMonths, remaining_months: remainingMonths,
    saved, remaining, progress_pct: progressPct,
    next_payment: nextPayment,
    days_to_maturity: daysToMaturity, started, matured, basis,
    complete: matured || remaining <= 0,
  };

  // ── Share plan: what the pot buys ───────────────────────────────────────
  if (plan.kind === 'shares' && plan.option_price > 0) {
    const opt = plan.option_price;
    const cur = plan.current_price > 0 ? plan.current_price : null;
    const sharesNow = Math.floor(saved / opt);
    const sharesAtEnd = Math.floor(maturityValue / opt);
    const cashLeftAtEnd = round2(maturityValue - sharesAtEnd * opt);
    out.shares = {
      option_price: opt,
      current_price: cur,
      shares_now: sharesNow,
      shares_at_maturity: sharesAtEnd,
      cash_left_at_maturity: cashLeftAtEnd,
      // Only meaningful with a current price to compare against.
      in_the_money: cur != null ? cur > opt : null,
      value_now: cur != null ? round2(sharesNow * cur) : null,
      value_at_maturity: cur != null ? round2(sharesAtEnd * cur + cashLeftAtEnd) : null,
      // Buying at the option price vs simply taking the cash out at maturity.
      // Negative means the shares are below the option price, so take the cash.
      gain_at_maturity: cur != null ? round2(sharesAtEnd * (cur - opt)) : null,
      discount_pct: cur != null && cur > 0 ? round1(((cur - opt) / cur) * 100) : null,
    };
  }
  return out;
}

function validate(body, existing) {
  const b = { ...(existing || {}), ...body };
  const name = String(b.name || '').trim();
  if (!name) return { error: 'Give it a name first' };
  const kind = b.kind || 'savings';
  if (!KINDS.includes(kind)) return { error: 'kind must be savings or shares' };
  const monthly = parseFloat(b.monthly_amount);
  if (!Number.isFinite(monthly) || monthly <= 0) return { error: 'Monthly payment must be more than zero' };
  const duration = parseInt(b.duration_months, 10);
  if (!Number.isInteger(duration) || duration < 1 || duration > 600) return { error: 'Duration must be between 1 and 600 months' };
  const start = b.start_date || localDateStr();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return { error: 'start_date must be YYYY-MM-DD' };
  const mode = b.count_mode || 'schedule';
  if (!COUNT_MODES.includes(mode)) return { error: 'count_mode must be schedule, payslips or manual' };
  const num = v => (v === '' || v == null) ? null : parseFloat(v);
  const option = num(b.option_price), current = num(b.current_price), bonus = num(b.bonus);
  if (kind === 'shares' && !(option > 0)) return { error: 'A share plan needs an option price (what one share costs you)' };
  if (current != null && !(current > 0)) return { error: 'Current share price must be more than zero' };
  if (bonus != null && bonus < 0) return { error: 'Bonus cannot be negative' };
  const manual = b.manual_paid_months === '' || b.manual_paid_months == null ? null : parseInt(b.manual_paid_months, 10);
  if (mode === 'manual' && !(manual >= 0)) return { error: 'Enter how many payments you have made so far' };
  return {
    value: {
      name, kind, monthly_amount: monthly, duration_months: duration, start_date: start,
      count_mode: mode, manual_paid_months: mode === 'manual' ? manual : null,
      option_price: kind === 'shares' ? option : null,
      current_price: kind === 'shares' ? current : null,
      bonus: bonus || 0,
      notes: b.notes ? String(b.notes).trim() : null,
      archived: b.archived ? 1 : 0,
    },
  };
}

router.get('/savings', (req, res) => {
  const rows = db.prepare('SELECT * FROM v3_savings ORDER BY archived ASC, start_date DESC, id DESC').all();
  res.json({ plans: rows.map(decorate), today: localDateStr() });
});

router.post('/savings', (req, res) => {
  const v = validate(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  const p = v.value;
  const info = db.prepare(`
    INSERT INTO v3_savings (name, kind, monthly_amount, duration_months, start_date, count_mode,
      manual_paid_months, option_price, current_price, bonus, notes, archived)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(p.name, p.kind, p.monthly_amount, p.duration_months, p.start_date, p.count_mode,
         p.manual_paid_months, p.option_price, p.current_price, p.bonus, p.notes, p.archived);
  res.status(201).json(decorate(db.prepare('SELECT * FROM v3_savings WHERE id = ?').get(info.lastInsertRowid)));
});

router.put('/savings/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM v3_savings WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const v = validate(req.body || {}, existing);
  if (v.error) return res.status(400).json({ error: v.error });
  const p = v.value;
  db.prepare(`
    UPDATE v3_savings SET name=?, kind=?, monthly_amount=?, duration_months=?, start_date=?, count_mode=?,
      manual_paid_months=?, option_price=?, current_price=?, bonus=?, notes=?, archived=?
    WHERE id=?
  `).run(p.name, p.kind, p.monthly_amount, p.duration_months, p.start_date, p.count_mode,
         p.manual_paid_months, p.option_price, p.current_price, p.bonus, p.notes, p.archived, req.params.id);
  res.json(decorate(db.prepare('SELECT * FROM v3_savings WHERE id = ?').get(req.params.id)));
});

router.delete('/savings/:id', (req, res) => {
  const info = db.prepare('DELETE FROM v3_savings WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ deleted: true });
});

module.exports = router;
module.exports.decorate = decorate;   // exported for the tests
