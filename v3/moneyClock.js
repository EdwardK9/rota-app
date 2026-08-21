/* ─── 💸 Money Clock (V3.0) ────────────────────────────────────────────────
   GET /api/v3/money-clock

   The live "how much have I made" view. Returns everything the client needs to
   tick a counter locally once per second without hammering the server: the
   in-progress shift's window and pence-per-second rate, plus already-banked
   totals for today / week / month / year / lifetime, and a countdown to the
   next payday inferred from your real payslip payment dates.
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');
const {
  db, getSetting, localDateStr, parseDate, addDays, daysBetween,
  mondayOf, toMins, spanMins, paidHours, shiftPay, rateForDate, round2,
} = require('./helpers');

const router = express.Router();

/** Day-of-month payslips actually land on: the most common payment_date day,
 *  falling back to a setting and then to Screwfix's usual 28th. */
function paydayDayOfMonth() {
  const rows = db.prepare(
    "SELECT payment_date FROM payslips WHERE payment_date IS NOT NULL AND payment_date != ''"
  ).all();
  const tally = {};
  for (const r of rows) {
    const day = parseInt(String(r.payment_date).slice(8, 10), 10);
    if (day >= 1 && day <= 31) tally[day] = (tally[day] || 0) + 1;
  }
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
  if (top) return parseInt(top[0], 10);
  const configured = parseInt(getSetting('v3_payday_day', ''), 10);
  return Number.isFinite(configured) ? configured : 28;
}

/** Payday for a given year/month, pulled back to the Friday if it lands on a
 *  weekend (how monthly BACS runs actually behave) and clamped to month length. */
function paydayFor(year, month, dayOfMonth) {
  const lastDay = new Date(year, month, 0).getDate();
  const d = new Date(year, month - 1, Math.min(dayOfMonth, lastDay), 12, 0, 0);
  if (d.getDay() === 6) d.setDate(d.getDate() - 1);   // Sat -> Fri
  if (d.getDay() === 0) d.setDate(d.getDate() - 2);   // Sun -> Fri
  return localDateStr(d);
}

function nextPayday(today, dayOfMonth) {
  const d = parseDate(today);
  let candidate = paydayFor(d.getFullYear(), d.getMonth() + 1, dayOfMonth);
  if (candidate < today) {
    const next = new Date(d.getFullYear(), d.getMonth() + 1, 1, 12, 0, 0);
    candidate = paydayFor(next.getFullYear(), next.getMonth() + 1, dayOfMonth);
  }
  return candidate;
}

const sumPay = rows => round2(rows.reduce((t, s) => t + (shiftPay(s) || 0), 0));

router.get('/money-clock', (req, res) => {
  const today = localDateStr();
  const nowMins = new Date().getHours() * 60 + new Date().getMinutes() + new Date().getSeconds() / 60;

  const weekStart  = mondayOf(today);
  const monthStart = today.slice(0, 7) + '-01';
  const yearStart  = today.slice(0, 4) + '-01-01';

  const range = (from, to) =>
    db.prepare('SELECT * FROM shifts WHERE date >= ? AND date <= ? ORDER BY date ASC, start_time ASC').all(from, to);

  const todayShifts = range(today, today);
  const weekShifts  = range(weekStart, addDays(weekStart, 6));
  const monthShifts = range(monthStart, today);
  const yearShifts  = range(yearStart, today);
  const allShifts   = db.prepare('SELECT * FROM shifts').all();

  // ── In-progress shift ────────────────────────────────────────────────────
  // "In progress" means now sits between start and end. Pay accrues linearly
  // across the paid hours of the shift (the scheduled break is already netted
  // out of paidHours, so the counter is honest rather than flattering).
  let live = null;
  for (const s of todayShifts) {
    const start = toMins(s.start_time);
    const total = spanMins(s.start_time, s.end_time);
    const end   = start + total;
    if (nowMins < start || nowMins > end) continue;

    const hours = paidHours(s);
    const pay   = shiftPay(s) || 0;
    const elapsedMins = nowMins - start;
    live = {
      shift_id: s.id,
      start_time: s.start_time,
      end_time: s.end_time,
      total_mins: total,
      elapsed_mins: Math.round(elapsedMins),
      remaining_mins: Math.max(0, Math.round(end - nowMins)),
      progress_pct: Math.round((elapsedMins / total) * 1000) / 10,
      shift_pay: pay,
      paid_hours: Math.round(hours * 100) / 100,
      // Client ticks with this — pay spread evenly over the shift's wall-clock length
      pay_per_second: total > 0 ? pay / (total * 60) : 0,
      earned_so_far: round2(Math.min(pay, (pay / total) * elapsedMins)),
      is_bank_holiday: !!s.is_bank_holiday,
    };
    break;
  }

  // ── Next shift, when nothing is running right now ────────────────────────
  const upcoming = db.prepare(
    'SELECT * FROM shifts WHERE date >= ? ORDER BY date ASC, start_time ASC LIMIT 8'
  ).all(today).find(s => s.date > today || toMins(s.start_time) > nowMins);

  // ── Payday ───────────────────────────────────────────────────────────────
  const payDay  = paydayDayOfMonth();
  const payDate = nextPayday(today, payDay);
  const lastPayslip = db.prepare('SELECT * FROM payslips ORDER BY month DESC LIMIT 1').get();

  // Everything worked since the last payday is roughly what the next one covers.
  // The last payday is the one a whole month BEFORE the next one — stepping back
  // a single day lands in the same month whenever payday is late in it, which
  // would make "earned since" span nothing at all.
  const payD = parseDate(payDate);
  const prevMonth = new Date(payD.getFullYear(), payD.getMonth() - 1, 1, 12, 0, 0);
  const prevPayday = paydayFor(prevMonth.getFullYear(), prevMonth.getMonth() + 1, payDay);
  // Count from the day after, so a shift never lands in two pay periods at once.
  const accruedFrom = addDays(prevPayday, 1);
  const sinceLastPayday = range(accruedFrom, today);

  res.json({
    now: new Date().toISOString(),
    today,
    live,
    next_shift: upcoming
      ? { date: upcoming.date, start_time: upcoming.start_time, end_time: upcoming.end_time,
          pay: shiftPay(upcoming), days_away: daysBetween(today, upcoming.date) }
      : null,
    current_rate: rateForDate(today),
    totals: {
      today:    sumPay(todayShifts),
      week:     sumPay(weekShifts),
      month:    sumPay(monthShifts),
      year:     sumPay(yearShifts),
      lifetime: sumPay(allShifts),
      lifetime_hours: Math.round(allShifts.reduce((t, s) => t + paidHours(s), 0) * 10) / 10,
      lifetime_shifts: allShifts.length,
    },
    payday: {
      date: payDate,
      day_of_month: payDay,
      days_away: daysBetween(today, payDate),
      accrued_since_last: sumPay(sinceLastPayday),
      accrued_from: accruedFrom,
      accrued_shifts: sinceLastPayday.length,
      last_payday: prevPayday,
      last_net: lastPayslip ? lastPayslip.net_payment : null,
      last_month: lastPayslip ? lastPayslip.month : null,
    },
    week_start: weekStart,
  });
});

module.exports = router;
module.exports.paydayDayOfMonth = paydayDayOfMonth;
module.exports.nextPayday = nextPayday;
