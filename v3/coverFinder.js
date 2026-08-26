/* ─── 🔁 Cover Finder (V3.0) ───────────────────────────────────────────────
   GET /api/v3/cover-finder[?date=YYYY-MM-DD]

   "I need Saturday off — who could actually take it?" The app already knows the
   team's rota, their contracted hours and who normally works which slot, so the
   answer is sitting in the database; it just has never been asked the question
   in this direction.

   For one of your upcoming shifts this ranks everybody by how plausible they
   are as cover: free that day first, then how often they work that slot anyway,
   how much room they have left under their contract that week, and whether
   they're still actively on the rota. It also looks the other way and finds
   shifts of theirs you could take in exchange, so you can offer a swap rather
   than a favour.

   Read-only and advisory — nothing here books, messages or changes anything.
   It gets you a shortlist to go and ask, in the order worth asking.
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');
const {
  db, DAYS, getNumSetting, localDateStr, addDays, daysBetween, dowIndex, mondayOf,
  toMins, spanMins, overlapMins, paidHours, shiftPay, round1, round2, pct, clamp,
} = require('./helpers');

const router = express.Router();

/* How far either side of the shift to look for something to swap for. Three
   weeks forward covers the published rota; two back covers "I'll take yours
   next week instead". */
const SWAP_BACK_DAYS = 14;
const SWAP_FORWARD_DAYS = 21;

/** Hours in a colleague_shifts row. All-day rows (leave imported from Rotageek)
 *  carry 00:00–00:00, so they use the same hours_per_day the Leave view does. */
function colleagueHours(row, hoursPerDay) {
  if (row.shift_type === 'all_day') return hoursPerDay;
  return spanMins(row.start_time, row.end_time) / 60;
}

/** Colleagues still on the rota as at `date` — anyone with a leaving date
 *  already behind us can't cover anything. */
function activeColleagues(date) {
  return db.prepare(`
    SELECT id, name, job_tier, tags, synergy_rating, contract_hours, start_date, left_date
    FROM colleagues
    WHERE (left_date IS NULL OR left_date = '' OR left_date >= ?)
      AND (start_date IS NULL OR start_date = '' OR start_date <= ?)
    ORDER BY name ASC
  `).all(date, date);
}

/** Dates you are unavailable to take anything on: your own shifts, plus leave. */
function myBusyDates(from, to) {
  const busy = new Set(
    db.prepare('SELECT date FROM shifts WHERE date >= ? AND date <= ?').all(from, to).map(r => r.date)
  );
  const leave = db.prepare(
    'SELECT start_date, end_date FROM leave_entries WHERE end_date >= ? AND start_date <= ?'
  ).all(from, to);
  for (const l of leave) {
    for (let d = l.start_date; d <= l.end_date; d = addDays(d, 1)) busy.add(d);
  }
  return busy;
}

router.get('/cover-finder', (req, res) => {
  const today = localDateStr();
  const hoursPerDay = getNumSetting('hours_per_day', 7.4);

  // Your own shifts you might want covering — the picker at the top of the view.
  // A shift that finished this morning is not one you need cover for, so today
  // only counts until it's actually over.
  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const upcoming = db.prepare(
    'SELECT * FROM shifts WHERE date >= ? ORDER BY date ASC, start_time ASC LIMIT 40'
  ).all(today)
    .filter(s => s.date > today || toMins(s.start_time) + spanMins(s.start_time, s.end_time) > nowMins);

  const wanted = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
  const shift = wanted
    ? db.prepare('SELECT * FROM shifts WHERE date = ? ORDER BY start_time ASC').get(wanted)
    : upcoming[0];

  const myShifts = upcoming.map(s => ({
    id: s.id,
    date: s.date,
    day: DAYS[dowIndex(s.date)],
    start_time: s.start_time,
    end_time: s.end_time,
    hours: round1(paidHours(s)),
    pay: round2(shiftPay(s) || 0),
    days_away: daysBetween(today, s.date),
    selected: !!shift && s.date === shift.date,
  }));

  if (!shift) return res.json({ today, my_shifts: myShifts, shift: null });

  const dow = dowIndex(shift.date);
  const lengthMins = spanMins(shift.start_time, shift.end_time);
  const midMins = (toMins(shift.start_time) + lengthMins / 2) % 1440;
  const weekStart = mondayOf(shift.date);
  const weekEnd = addDays(weekStart, 6);

  /* ── One pass over the team's history ──────────────────────────────────── */
  // Home-store shifts only: a shift at another store is somebody else's rota and
  // says nothing about whether they can cover yours.
  const history = db.prepare(`
    SELECT colleague_id, date, start_time, end_time, shift_type
    FROM colleague_shifts
    WHERE (store IS NULL OR store = '') AND date <= ?
    ORDER BY date ASC
  `).all(today);

  const stats = new Map();   // colleague_id -> rolled-up history
  const statOf = id => {
    if (!stats.has(id)) {
      stats.set(id, {
        total: 0, slot_matches: 0, covers_mid: 0, last_worked: null, recent: 0,
        weekday_dates: new Set(),
      });
    }
    return stats.get(id);
  };
  const sinceRecent = addDays(today, -28);
  // Rates are measured over the last year only. Over all time they drift out of
  // date — somebody who did every Saturday two contracts ago isn't a Saturday
  // person now — and, counted against a one-year denominator, they can exceed
  // 100%, which is how this was first written and plainly wrong.
  const rateWindow = addDays(today, -364);

  for (const row of history) {
    if (row.shift_type !== 'shift') continue;
    const st = statOf(row.colleague_id);
    if (row.date > (st.last_worked || '')) st.last_worked = row.date;
    if (row.date >= sinceRecent) st.recent += 1;
    if (row.date < rateWindow) continue;

    st.total += 1;
    if (dowIndex(row.date) === dow) {
      // By date, not by row: a split shift is still one Wednesday worked.
      st.weekday_dates.add(row.date);
      // "Works this slot": same weekday, and at least 60% of your shift covered
      // by theirs. Without the weekday test any full-timer matches everything,
      // because an 8-hour shift covers most of a 5-hour one whatever day it is.
      if (overlapMins(shift.start_time, shift.end_time, row.start_time, row.end_time) >= lengthMins * 0.6) {
        st.slot_matches += 1;
      }
    }
    // "Works this time of day at all": their shift spans the middle of yours
    const rowStart = toMins(row.start_time);
    const rowMins = spanMins(row.start_time, row.end_time);
    const offset = ((midMins - rowStart) + 1440) % 1440;
    if (offset <= rowMins) st.covers_mid += 1;
  }

  // Occurrences of this weekday in the last year, so weekday_pct is a share
  const weekdayOccurrences = (() => {
    let n = 0;
    for (let d = rateWindow; d < today; d = addDays(d, 1)) if (dowIndex(d) === dow) n++;
    return n;
  })();

  // What everyone is already doing that day, and that week
  const onDay = db.prepare('SELECT * FROM colleague_shifts WHERE date = ?').all(shift.date);
  const dayByColleague = new Map();
  for (const row of onDay) {
    // A different-store shift doesn't stop them covering here, but a home-store
    // one (or leave) does — keep whichever is more restrictive.
    const existing = dayByColleague.get(row.colleague_id);
    if (!existing || (existing.store && !row.store)) dayByColleague.set(row.colleague_id, row);
  }

  const weekRows = db.prepare(
    "SELECT colleague_id, start_time, end_time, shift_type FROM colleague_shifts " +
    "WHERE date >= ? AND date <= ? AND (store IS NULL OR store = '') AND shift_type != 'leave'"
  ).all(weekStart, weekEnd);
  const weekHours = new Map();
  for (const row of weekRows) {
    weekHours.set(row.colleague_id,
      (weekHours.get(row.colleague_id) || 0) + colleagueHours(row, hoursPerDay));
  }

  // How much of the floor you've actually shared with each of them
  const myDates = db.prepare('SELECT date, start_time, end_time FROM shifts WHERE date <= ?').all(today);
  const myByDate = new Map(myDates.map(s => [s.date, s]));
  const together = new Map();
  for (const row of history) {
    if (row.shift_type !== 'shift') continue;
    const mine = myByDate.get(row.date);
    if (!mine) continue;
    if (overlapMins(mine.start_time, mine.end_time, row.start_time, row.end_time) > 0) {
      together.set(row.colleague_id, (together.get(row.colleague_id) || 0) + 1);
    }
  }

  /* ── Score everybody ───────────────────────────────────────────────────── */
  const shiftHours = round1(paidHours(shift));

  const scored = activeColleagues(shift.date).map(c => {
    const st = statOf(c.id);
    const theirDay = dayByColleague.get(c.id);
    const booked = round1(weekHours.get(c.id) || 0);
    const contract = c.contract_hours || 0;
    const headroom = contract > 0 ? round1(contract - booked) : null;

    let status = 'free';
    if (theirDay && theirDay.store) status = 'other_store';
    else if (theirDay && (theirDay.shift_type === 'leave' || theirDay.shift_type === 'all_day')) status = 'leave';
    else if (theirDay) status = 'working';

    const weekdayCount = st.weekday_dates.size;
    const weekdayPct = pct(weekdayCount, weekdayOccurrences);
    const slotPct = pct(st.slot_matches, st.total);
    const timeFitPct = pct(st.covers_mid, st.total);
    const daysSinceSeen = st.last_worked ? daysBetween(st.last_worked, today) : null;

    const reasons = [], flags = [];
    let score = null;

    if (status === 'free' || status === 'other_store') {
      // Base credit for simply being free and on the rota
      score = 25;

      // Do they work this slot anyway? The single strongest signal.
      score += clamp(st.slot_matches * 3, 0, 25);
      if (st.slot_matches >= 3) {
        reasons.push(`Works this slot regularly — ${st.slot_matches} of the last ${weekdayOccurrences} ${DAYS[dow]}s`);
      } else if (st.slot_matches > 0) {
        reasons.push(`Has worked this slot ${st.slot_matches} time${st.slot_matches === 1 ? '' : 's'} this year`);
      } else {
        flags.push(`Hasn't worked this slot on a ${DAYS[dow]} this year`);
      }

      // Right end of the day, even if not this exact shift
      score += clamp(timeFitPct * 0.15, 0, 15);
      if (timeFitPct >= 60) reasons.push(`${timeFitPct}% of their shifts cover this time of day`);

      // Do they work this weekday at all?
      score += clamp(weekdayPct * 0.12, 0, 12);
      if (weekdayPct >= 50) reasons.push(`On the rota most ${DAYS[dow]}s (${weekdayPct}%)`);
      else if (weekdayPct < 15 && st.total > 10) flags.push(`Rarely works ${DAYS[dow]}s`);

      // Room under their contract that week
      if (headroom == null) {
        score += 6;   // unknown contract — neither reward nor punish
        flags.push('No contracted hours on file');
      } else if (headroom >= shiftHours) {
        score += 18;
        reasons.push(`${headroom}h spare under contract that week`);
      } else if (headroom > 0) {
        score += 18 * (headroom / shiftHours);
        flags.push(`Only ${headroom}h under contract — this shift is ${shiftHours}h`);
      } else {
        flags.push(`Already ${round1(Math.abs(headroom))}h over contract that week`);
      }

      // Still actually around
      if (daysSinceSeen == null) flags.push('No shifts on record');
      else if (daysSinceSeen <= 14) score += 10;
      else if (daysSinceSeen <= 28) score += 5;
      else flags.push(`Not seen on the rota for ${daysSinceSeen} days`);

      if (c.synergy_rating > 0) { score += 5; reasons.push('One of your better shifts together'); }
      else if (c.synergy_rating < 0) { score -= 5; flags.push('Marked as a difficult pairing'); }

      if (status === 'other_store') {
        score -= 15;
        flags.push('Rostered at another store that day');
      }

      score = Math.round(clamp(score, 0, 100));
    }

    return {
      id: c.id,
      name: c.name,
      job_tier: c.job_tier,
      tags: (() => { try { return JSON.parse(c.tags || '[]'); } catch (_) { return []; } })(),
      synergy_rating: c.synergy_rating || 0,
      status,
      their_shift: theirDay
        ? { start_time: theirDay.start_time, end_time: theirDay.end_time,
            shift_type: theirDay.shift_type, store: theirDay.store || null }
        : null,
      score,
      grade: score == null ? null : score >= 70 ? 'strong' : score >= 45 ? 'possible' : 'long-shot',
      reasons,
      flags,
      slot_matches: st.slot_matches,
      slot_pct: slotPct,
      weekday_pct: weekdayPct,
      time_fit_pct: timeFitPct,
      week_hours: booked,
      contract_hours: contract || null,
      headroom,
      last_worked: st.last_worked,
      days_since_seen: daysSinceSeen,
      shifts_this_year: st.total,
      shifts_together: together.get(c.id) || 0,
    };
  });

  const available = scored.filter(c => c.score != null).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const unavailable = scored.filter(c => c.score == null)
    .sort((a, b) => a.status.localeCompare(b.status) || a.name.localeCompare(b.name));

  /* ── Swaps: their shifts you could take instead ────────────────────────── */
  const swapFrom = addDays(shift.date, -SWAP_BACK_DAYS);
  const swapTo = addDays(shift.date, SWAP_FORWARD_DAYS);
  const busy = myBusyDates(swapFrom, swapTo);
  const shortlist = new Map(available.filter(c => c.grade !== 'long-shot').map(c => [c.id, c]));

  const swapRows = db.prepare(`
    SELECT cs.colleague_id, cs.date, cs.start_time, cs.end_time
    FROM colleague_shifts cs
    WHERE cs.date >= ? AND cs.date <= ? AND cs.date > ?
      AND cs.shift_type = 'shift' AND (cs.store IS NULL OR cs.store = '')
    ORDER BY cs.date ASC
  `).all(swapFrom, swapTo, today);

  const swaps = swapRows
    .filter(r => shortlist.has(r.colleague_id) && !busy.has(r.date) && r.date !== shift.date)
    .map(r => {
      const c = shortlist.get(r.colleague_id);
      const hours = round1(spanMins(r.start_time, r.end_time) / 60);
      return {
        colleague_id: r.colleague_id,
        name: c.name,
        cover_score: c.score,
        date: r.date,
        day: DAYS[dowIndex(r.date)],
        start_time: r.start_time,
        end_time: r.end_time,
        hours,
        // A swap only really works if you're not handing away hours
        hours_delta: round1(hours - shiftHours),
        days_away: daysBetween(today, r.date),
      };
    })
    .sort((a, b) => b.cover_score - a.cover_score || Math.abs(a.hours_delta) - Math.abs(b.hours_delta))
    .slice(0, 12);

  res.json({
    today,
    my_shifts: myShifts,
    shift: {
      id: shift.id,
      date: shift.date,
      day: DAYS[dow],
      start_time: shift.start_time,
      end_time: shift.end_time,
      hours: shiftHours,
      pay: round2(shiftPay(shift) || 0),
      days_away: daysBetween(today, shift.date),
      is_bank_holiday: !!shift.is_bank_holiday,
      notes: shift.notes || null,
    },
    week: { start: weekStart, end: weekEnd },
    counts: {
      team: scored.length,
      free: scored.filter(c => c.status === 'free').length,
      working: scored.filter(c => c.status === 'working').length,
      on_leave: scored.filter(c => c.status === 'leave').length,
      strong: available.filter(c => c.grade === 'strong').length,
    },
    available,
    unavailable,
    swaps,
  });
});

module.exports = router;
