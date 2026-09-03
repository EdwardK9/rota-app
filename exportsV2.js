/* ─── Data Exports (V2.0 Phase 6) ───────────────────────────────────────────
   Endpoints:
     GET /api/v1/export/team-analytics.csv?from&to  — flat CSV for Excel pivots
     GET /api/v1/export/daily-brief.pdf?date         — single-page printable brief

   The PDF route needs the "pdfkit" package. It's required lazily and guarded
   so a server that hasn't run `npm install` yet still starts fine — the PDF
   route just returns a clear 501 instead of crashing on boot.
   ───────────────────────────────────────────────────────────────────────── */

const express = require('express');
const { db, effectiveHourlyRate } = require('./db');
const fatigueAudit = require('./fatigueAudit');
const commute = require('./commute');
const router = express.Router();

let PDFDocument = null;
try { PDFDocument = require('pdfkit'); } catch (_) { /* not installed yet — handled per-route below */ }

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
const toMins = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

function shiftDurationHours(row, hoursPerDay) {
  if (row.shift_type === 'all_day') return hoursPerDay;
  let mins = toMins(row.end_time) - toMins(row.start_time);
  if (mins <= 0) mins += 24 * 60;
  return mins / 60;
}

/** Quote a CSV field per RFC 4180 — wrap in quotes and escape embedded quotes
 *  whenever the value contains a comma, quote, or newline. */
function csvField(v) {
  const s = v == null ? '' : String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// ─────────────────────────────────────────
// CSV export
// ─────────────────────────────────────────

router.get('/v1/export/team-analytics.csv', (req, res) => {
  const { from, to } = req.query;
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ error: 'from and to (YYYY-MM-DD) are required' });
  }

  const hoursPerDay = parseFloat(getSetting('hours_per_day', '7.4')) || 7.4;
  const rows = db.prepare(`
    SELECT cs.*, c.name, c.pay_type, c.hourly_rate, c.annual_salary, c.nominal_weekly_hours,
           c.job_tier, c.pay_override
    FROM colleague_shifts cs
    JOIN colleagues c ON c.id = cs.colleague_id
    WHERE cs.date >= ? AND cs.date <= ? AND cs.shift_type != 'leave'
    ORDER BY cs.date ASC, c.name ASC
  `).all(from, to);

  const flagsLookup = fatigueAudit.computeFlagsForRange(from, to);

  const header = ['Date', 'Staff Name', 'Shift Start', 'Shift End', 'Hours', 'Hourly Rate', 'Total Shift Cost', 'Fatigue Flags'];
  const lines = [header.map(csvField).join(',')];

  for (const r of rows) {
    const hours = Math.round(shiftDurationHours(r, hoursPerDay) * 100) / 100;
    const rate = effectiveHourlyRate(r, r.date);
    const cost = rate != null ? Math.round(hours * rate * 100) / 100 : '';
    const flags = (flagsLookup[r.colleague_id]?.flagsByDate[r.date] || []).join('; ');
    const isAllDay = r.shift_type === 'all_day';
    lines.push([
      r.date, r.name,
      isAllDay ? 'All day' : r.start_time,
      isAllDay ? 'All day' : r.end_time,
      hours, rate != null ? rate.toFixed(2) : '', cost, flags,
    ].map(csvField).join(','));
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="team-analytics_${from}_to_${to}.csv"`);
  res.send(lines.join('\r\n'));
});

// ─────────────────────────────────────────
// Daily Shift Brief PDF
// ─────────────────────────────────────────

router.get('/v1/export/daily-brief.pdf', async (req, res) => {
  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date (YYYY-MM-DD) required' });
  if (!PDFDocument) {
    return res.status(501).json({ error: "PDF export needs the 'pdfkit' package — run `npm install` on the server and restart it." });
  }

  const roster = db.prepare(`
    SELECT cs.*, c.name, c.tags
    FROM colleague_shifts cs JOIN colleagues c ON c.id = cs.colleague_id
    WHERE cs.date = ? AND cs.shift_type != 'leave'
    ORDER BY cs.start_time ASC
  `).all(date);

  const decorated = roster.map(r => {
    let tags = []; try { tags = r.tags ? JSON.parse(r.tags) : []; } catch (_) {}
    return { ...r, tags };
  });
  const keyholders = decorated.filter(r => r.tags.some(t => /keyholder/i.test(t)));

  // Hourly headcount, 06:00-23:00
  const HOURS = Array.from({ length: 18 }, (_, i) => i + 6);
  const headcount = HOURS.map(h => {
    const hourStart = h * 60, hourEnd = (h + 1) * 60;
    const count = decorated.filter(r => {
      if (r.shift_type === 'all_day') return true;
      let s = toMins(r.start_time), e = toMins(r.end_time);
      if (e <= s) e += 24 * 60;
      return s < hourEnd && e > hourStart;
    }).length;
    return { hour: h, count };
  });

  // Best-effort midday weather for the day (home location, if configured)
  let weather = null;
  try {
    const homeLat = commute.getSetting('commute_home_lat'), homeLon = commute.getSetting('commute_home_lon');
    if (homeLat && homeLon) {
      const forecast = await commute.fetchHourlyForecast(homeLat, homeLon, date);
      const midday = new Date(`${date}T12:00:00`);
      const point = forecast[commute.nearestHourKey(midday)];
      if (point) {
        const w = commute.weatherLabel(point.code);
        weather = { temp: point.temp, description: w.label, icon: w.icon, alerts: commute.buildAlerts(point) };
      }
    }
  } catch (_) { /* weather is a nice-to-have on this brief — don't fail the PDF over it */ }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="daily-brief_${date}.pdf"`);

  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(res);

  const dayLabel = new Date(date + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  doc.fontSize(20).text('Daily Shift Brief', { align: 'left' });
  doc.fontSize(13).fillColor('#555').text(dayLabel);
  doc.moveDown(1);

  if (weather) {
    doc.fontSize(12).fillColor('#000').text(`Weather: ${weather.icon} ${weather.description}, ${Math.round(weather.temp)}°C` +
      (weather.alerts.length ? `  —  ${weather.alerts.map(a => a.text).join(', ')}` : ''));
    doc.moveDown(1);
  }

  // Hourly headcount bar chart (simple vector bars)
  doc.fontSize(13).text('Hourly Headcount', { underline: true });
  doc.moveDown(0.3);
  const chartTop = doc.y, chartHeight = 80, barWidth = 24, gap = 4;
  const maxCount = Math.max(...headcount.map(h => h.count), 1);
  headcount.forEach((h, i) => {
    const barH = h.count > 0 ? Math.max((h.count / maxCount) * chartHeight, 4) : 0;
    const x = 40 + i * (barWidth + gap);
    const color = h.count === 0 ? '#e5e7eb' : h.count <= 2 ? '#ef4444' : h.count === 3 ? '#f59e0b' : '#10b981';
    doc.rect(x, chartTop + chartHeight - barH, barWidth, barH).fill(color);
    doc.fillColor('#000').fontSize(7).text(String(h.hour), x, chartTop + chartHeight + 4, { width: barWidth, align: 'center' });
    if (h.count > 0) doc.fontSize(7).text(String(h.count), x, chartTop + chartHeight - barH - 10, { width: barWidth, align: 'center' });
  });
  doc.y = chartTop + chartHeight + 20;
  doc.x = 40;
  doc.moveDown(1.5);

  // Shift schedule (break times aren't tracked per colleague, so this shows windows only)
  doc.fontSize(13).fillColor('#000').text('Shift Schedule', { underline: true });
  doc.fontSize(9).fillColor('#666').text("Break times aren't tracked per colleague — showing shift windows only.");
  doc.moveDown(0.4);
  doc.fontSize(11).fillColor('#000');
  if (decorated.length) {
    decorated.forEach(r => {
      const timeLabel = r.shift_type === 'all_day' ? 'All day' : `${r.start_time} – ${r.end_time}`;
      doc.text(`${r.name}  —  ${timeLabel}`);
    });
  } else {
    doc.fillColor('#888').text('No colleague shifts recorded for this day.');
  }
  doc.moveDown(1);

  // Keyholders
  doc.fillColor('#000').fontSize(13).text('Keyholders', { underline: true });
  doc.fontSize(11).moveDown(0.3);
  doc.text(keyholders.length ? keyholders.map(k => k.name).join(', ') : 'None tagged for this day.');

  doc.end();
});

module.exports = router;
