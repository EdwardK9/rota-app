/* ─── ⏳ Countdown Board (V3.0) ────────────────────────────────────────────
   GET /api/v3/countdowns

   Every "how long until…" the app can answer, on one board: next shift, payday,
   booked leave, the next bank holiday, colleague birthdays, your work
   anniversary, and the end of the tax year.

   Each entry carries an ISO target timestamp so the client can tick a live
   HH:MM:SS countdown without asking the server again.
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');
const {
  db, DAYS, getSetting, localDateStr, parseDate, addDays, daysBetween, toMins, shiftPay, round2,
} = require('./helpers');
const { paydayDayOfMonth, nextPayday } = require('./moneyClock');
const { leaveSummary } = require('./leaveYear');
const { bankHolidayList } = require('./bankHolidays');

const router = express.Router();

/** Local ISO timestamp for a date + HH:MM, so the client counts down to the
 *  right wall-clock moment rather than to midnight UTC. */
function targetAt(dateStr, time = '00:00') {
  const d = parseDate(dateStr);
  const [h, m] = time.split(':').map(Number);
  d.setHours(h, m || 0, 0, 0);
  return d.toISOString();
}

/** Next occurrence of an MM-DD anniversary on or after `from`. */
function nextAnniversary(mmdd, from) {
  const year = parseInt(from.slice(0, 4), 10);
  const thisYear = `${year}-${mmdd}`;
  return thisYear >= from ? thisYear : `${year + 1}-${mmdd}`;
}

router.get('/countdowns', async (req, res) => {
  const today = localDateStr();
  const nowMins = new Date().getHours() * 60 + new Date().getMinutes();
  const items = [];

  const add = (o) => { if (o && o.date) items.push({ ...o, days_away: daysBetween(today, o.date) }); };

  // ── Next shift ───────────────────────────────────────────────────────────
  const nextShift = db.prepare('SELECT * FROM shifts WHERE date >= ? ORDER BY date ASC, start_time ASC LIMIT 10')
    .all(today)
    .find(s => s.date > today || toMins(s.start_time) > nowMins);
  if (nextShift) {
    add({
      key: 'next_shift', icon: '📋', title: 'Next shift', category: 'work',
      date: nextShift.date, time: nextShift.start_time, target: targetAt(nextShift.date, nextShift.start_time),
      detail: `${DAYS[parseDate(nextShift.date).getDay()]} · ${nextShift.start_time}–${nextShift.end_time}`,
      value: `£${round2(shiftPay(nextShift) || 0).toFixed(2)}`,
    });
  }

  // ── End of the current shift, if one is running ──────────────────────────
  const running = db.prepare('SELECT * FROM shifts WHERE date = ? ORDER BY start_time ASC').all(today)
    .find(s => toMins(s.start_time) <= nowMins && toMins(s.end_time) > nowMins);
  if (running) {
    add({
      key: 'shift_end', icon: '🏁', title: 'Home time', category: 'work',
      date: today, time: running.end_time, target: targetAt(today, running.end_time),
      detail: `You are on shift until ${running.end_time}`,
    });
  }

  // ── Next day off ─────────────────────────────────────────────────────────
  const upcomingDates = new Set(
    db.prepare('SELECT DISTINCT date FROM shifts WHERE date >= ? AND date <= ?')
      .all(today, addDays(today, 30)).map(r => r.date)
  );
  for (let i = 0; i <= 30; i++) {
    const d = addDays(today, i);
    if (!upcomingDates.has(d)) {
      add({ key: 'next_day_off', icon: '🛌', title: 'Next day off', category: 'rest',
            date: d, target: targetAt(d, '00:00'),
            detail: DAYS[parseDate(d).getDay()] });
      break;
    }
  }

  // ── Payday ───────────────────────────────────────────────────────────────
  const payDate = nextPayday(today, paydayDayOfMonth());
  const lastSlip = db.prepare('SELECT * FROM payslips ORDER BY month DESC LIMIT 1').get();
  add({
    key: 'payday', icon: '💷', title: 'Payday', category: 'money',
    date: payDate, target: targetAt(payDate, '00:00'),
    detail: lastSlip ? `Last one was £${round2(lastSlip.net_payment || 0).toFixed(2)} net` : 'Monthly pay run',
  });

  // ── Booked leave ─────────────────────────────────────────────────────────
  const nextLeave = db.prepare('SELECT * FROM leave_entries WHERE end_date >= ? ORDER BY start_date ASC LIMIT 1').get(today);
  if (nextLeave) {
    const started = nextLeave.start_date <= today;
    add({
      key: 'leave', icon: '🏖️', title: started ? 'Back to work' : 'Booked leave', category: 'rest',
      date: started ? addDays(nextLeave.end_date, 1) : nextLeave.start_date,
      target: targetAt(started ? addDays(nextLeave.end_date, 1) : nextLeave.start_date, '00:00'),
      detail: started
        ? `On ${nextLeave.leave_type} leave until ${nextLeave.end_date}`
        : `${nextLeave.days_taken} day${nextLeave.days_taken === 1 ? '' : 's'} of ${nextLeave.leave_type} leave`,
    });
  }

  // ── Bank holiday ─────────────────────────────────────────────────────────
  const bankHols = await bankHolidayList();
  const nextBH = bankHols.filter(b => b.date >= today).sort((a, b) => a.date.localeCompare(b.date))[0];
  if (nextBH) {
    const working = db.prepare('SELECT COUNT(*) AS c FROM shifts WHERE date = ?').get(nextBH.date).c > 0;
    add({
      key: 'bank_holiday', icon: '🎆', title: 'Next bank holiday', category: 'rest',
      date: nextBH.date, target: targetAt(nextBH.date, '00:00'),
      detail: nextBH.title + (working ? ' — and you are rota’d on (double pay)' : ''),
    });
  }

  // ── Work anniversary & birthdays ─────────────────────────────────────────
  const jobStart = getSetting('job_start_date', null);
  if (jobStart && /^\d{4}-\d{2}-\d{2}$/.test(jobStart)) {
    const next = nextAnniversary(jobStart.slice(5), today);
    const years = parseInt(next.slice(0, 4), 10) - parseInt(jobStart.slice(0, 4), 10);
    add({
      key: 'work_anniversary', icon: '🎊', title: 'Work anniversary', category: 'milestone',
      date: next, target: targetAt(next, '00:00'),
      detail: `${years} year${years === 1 ? '' : 's'} at ${getSetting('employer', 'work')}`,
    });
  }

  const dob = getSetting('user_dob', null);
  if (dob && /^\d{4}-\d{2}-\d{2}$/.test(dob)) {
    const next = nextAnniversary(dob.slice(5), today);
    add({
      key: 'birthday', icon: '🎂', title: 'Your birthday', category: 'milestone',
      date: next, target: targetAt(next, '00:00'),
      detail: `Turning ${parseInt(next.slice(0, 4), 10) - parseInt(dob.slice(0, 4), 10)}`,
    });
  }

  const colleagueBirthdays = db.prepare(
    "SELECT name, birthday FROM colleagues WHERE birthday IS NOT NULL AND birthday != '' AND (left_date IS NULL OR left_date = '')"
  ).all()
    .map(c => {
      const b = String(c.birthday);
      const mmdd = b.length >= 10 ? b.slice(5) : b.replace(/^-+/, '');
      if (!/^\d{2}-\d{2}$/.test(mmdd)) return null;
      return { name: c.name, date: nextAnniversary(mmdd, today) };
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (colleagueBirthdays.length) {
    const soonest = colleagueBirthdays[0];
    const sameDay = colleagueBirthdays.filter(c => c.date === soonest.date).map(c => c.name);
    add({
      key: 'colleague_birthday', icon: '🎈',
      title: sameDay.length > 1 ? 'Colleague birthdays' : `${soonest.name}'s birthday`,
      category: 'milestone', date: soonest.date, target: targetAt(soonest.date, '00:00'),
      detail: sameDay.join(', '),
    });
  }

  // ── End of tax year & leave year ─────────────────────────────────────────
  const taxYearEnd = nextAnniversary('04-05', today);
  add({
    key: 'tax_year_end', icon: '🧾', title: 'End of tax year', category: 'money',
    date: taxYearEnd, target: targetAt(taxYearEnd, '00:00'),
    detail: 'Your P60 figures are locked in on this date',
  });

  // Leave-year reset. The window and the "remaining" figure both come from
  // leaveYear.js, which mirrors the Leave view — so this can't drift from what
  // the Leave tab shows.
  const leave = leaveSummary(today);
  if (/^\d{2}-\d{2}$/.test(leave.lys)) {
    let detail;
    if (!leave.configured) {
      detail = 'No entitlement set for this leave year yet';
    } else if (leave.remaining_hours > 0) {
      const days = leave.remaining_days;
      detail = `${leave.remaining_hours}h left to book or lose` +
               (days >= 0.5 ? ` (about ${days} day${days === 1 ? '' : 's'})` : '');
    } else if (leave.remaining_hours === 0) {
      detail = 'Entitlement fully used';
    } else {
      detail = `${Math.abs(leave.remaining_hours)}h over your entitlement`;
    }
    add({
      key: 'leave_year_end', icon: '📆', title: 'Leave year resets', category: 'rest',
      date: leave.end, target: targetAt(leave.end, '00:00'),
      detail,
    });
  }

  items.sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''));

  res.json({ now: new Date().toISOString(), today, countdowns: items });
});

module.exports = router;
