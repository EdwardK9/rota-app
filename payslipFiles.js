/* ─── Payslip documents ───────────────────────────────────────────────────────
   A safe copy of the original payslip PDFs, and nothing more. Nothing here reads
   the files, extracts figures from them, or lets anything else on the Payslips
   page depend on them — that's what the Gemini photo import is for, and this is
   deliberately separate from it. Upload, list, download, delete.

   Storage follows the photo library's split: metadata in the payslip_files
   table, the file itself on disk under DATA_DIR/payslip-files/<month>/, so the
   database file stays small enough to keep backing up nightly. Note the flip
   side, and say so in the UI: these files live in the data volume, so they ride
   on whatever backs that up — the nightly GitHub backup only carries the .db.
   ───────────────────────────────────────────────────────────────────────────── */

const express = require('express');
const multer  = require('multer');
const fs      = require('fs');
const path    = require('path');
const { db }  = require('./db');

const router = express.Router();

const DATA_DIR  = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILES_DIR = path.join(DATA_DIR, 'payslip-files');
if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });

// A payslip PDF is a few hundred KB; 25MB a file leaves room for a phone photo
// of one without inviting anything that has no business being here.
const MAX_BYTES = 25 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 20 } });

const ALLOWED = /^(application\/pdf|image\/(jpeg|png|webp|heic|heif))$/i;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// Strip anything that could climb out of the month directory or upset a shell
// later; the display name is kept unchanged in the database either way.
const safeDiskName = (name) =>
  Date.now() + '_' + String(name).replace(/[^a-zA-Z0-9._\- ]/g, '_').slice(-120);

const publicRow = (r) => ({
  id: r.id, month: r.month, filename: r.filename, mime_type: r.mime_type,
  size_bytes: r.size_bytes, notes: r.notes, uploaded_at: r.uploaded_at,
  missing: !r.file_path || !fs.existsSync(r.file_path),
});

// GET /api/payslip-files?year=2026 — newest month first, newest upload first
router.get('/payslip-files', (req, res) => {
  try {
    const { year } = req.query;
    const rows = year
      ? db.prepare('SELECT * FROM payslip_files WHERE month LIKE ? ORDER BY month DESC, uploaded_at DESC').all(`${year}-%`)
      : db.prepare('SELECT * FROM payslip_files ORDER BY month DESC, uploaded_at DESC').all();
    res.json({ files: rows.map(publicRow) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/payslip-files/years — years that actually have documents, so the UI
// can say when there's something filed outside the year being looked at
router.get('/payslip-files/years', (req, res) => {
  try {
    const rows = db.prepare(
      "SELECT substr(month, 1, 4) AS year, COUNT(*) AS count FROM payslip_files GROUP BY year ORDER BY year DESC"
    ).all();
    res.json({ years: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/payslip-files — multipart, field "files", plus month + optional notes
router.post('/payslip-files', upload.array('files', 20), (req, res) => {
  const files = req.files || [];
  const month = String(req.body.month || '').trim();
  const notes = String(req.body.notes || '').trim() || null;

  if (!files.length) return res.status(400).json({ error: 'No files uploaded' });
  if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'A month (YYYY-MM) is required' });

  const rejected = files.filter(f => !ALLOWED.test(f.mimetype || ''));
  if (rejected.length) {
    return res.status(400).json({
      error: `Only PDFs and images can be stored — ${rejected.map(f => f.originalname).join(', ')} ${rejected.length === 1 ? 'is' : 'are'} neither`,
    });
  }

  try {
    const dir = path.join(FILES_DIR, month);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const insert = db.prepare(
      'INSERT INTO payslip_files (month, filename, mime_type, size_bytes, file_path, notes) VALUES (?,?,?,?,?,?)'
    );
    const written = [];
    try {
      db.transaction(() => {
        for (const f of files) {
          const filePath = path.join(dir, safeDiskName(f.originalname));
          fs.writeFileSync(filePath, f.buffer);
          written.push(filePath);
          insert.run(month, f.originalname, f.mimetype, f.size, filePath, notes);
        }
      })();
    } catch (e) {
      // Don't leave files on disk that no row points at.
      for (const p of written) { try { fs.unlinkSync(p); } catch (_) {} }
      throw e;
    }
    res.json({ inserted: files.length, month });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/payslip-files/:id — the file itself. Inline so a PDF opens in the
// browser's own viewer; ?download=1 for a save-as instead.
router.get('/payslip-files/:id', (req, res) => {
  try {
    const f = db.prepare('SELECT * FROM payslip_files WHERE id=?').get(parseInt(req.params.id, 10));
    if (!f) return res.status(404).json({ error: 'Not found' });
    if (!f.file_path || !fs.existsSync(f.file_path)) {
      return res.status(410).json({ error: 'The file is no longer on disk — only its record remains' });
    }
    const disposition = req.query.download ? 'attachment' : 'inline';
    res.setHeader('Content-Type', f.mime_type || 'application/pdf');
    res.setHeader('Content-Length', f.size_bytes || fs.statSync(f.file_path).size);
    res.setHeader('Content-Disposition', `${disposition}; filename="${f.filename.replace(/"/g, '')}"`);
    fs.createReadStream(f.file_path).pipe(res);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/payslip-files/:id — retag the month, rename, or add a note. Moves
// the file into the new month's directory so disk and database agree.
router.patch('/payslip-files/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const f  = db.prepare('SELECT * FROM payslip_files WHERE id=?').get(id);
    if (!f) return res.status(404).json({ error: 'Not found' });

    const month    = req.body.month    !== undefined ? String(req.body.month).trim()    : f.month;
    const filename = req.body.filename !== undefined ? String(req.body.filename).trim() : f.filename;
    const notes    = req.body.notes    !== undefined ? (String(req.body.notes).trim() || null) : f.notes;
    if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'Month must be YYYY-MM' });
    if (!filename)             return res.status(400).json({ error: 'Filename cannot be empty' });

    let filePath = f.file_path;
    if (month !== f.month && filePath && fs.existsSync(filePath)) {
      const dir = path.join(FILES_DIR, month);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const moved = path.join(dir, path.basename(filePath));
      fs.renameSync(filePath, moved);
      filePath = moved;
    }
    db.prepare('UPDATE payslip_files SET month=?, filename=?, notes=?, file_path=? WHERE id=?')
      .run(month, filename, notes, filePath, id);
    res.json(publicRow(db.prepare('SELECT * FROM payslip_files WHERE id=?').get(id)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/payslip-files/:id — removes the record and the file
router.delete('/payslip-files/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const f = db.prepare('SELECT file_path FROM payslip_files WHERE id=?').get(id);
    if (!f) return res.status(404).json({ error: 'Not found' });
    if (f.file_path && fs.existsSync(f.file_path)) fs.unlinkSync(f.file_path);
    db.prepare('DELETE FROM payslip_files WHERE id=?').run(id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Multer's own errors (a file over the limit, too many at once) arrive as
// exceptions rather than 4xx responses, so turn them into something readable.
router.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `That file is over the ${Math.round(MAX_BYTES / 1024 / 1024)}MB limit` });
  }
  if (err && err.code === 'LIMIT_FILE_COUNT') {
    return res.status(413).json({ error: 'Too many files at once — 20 is the limit' });
  }
  if (err) return res.status(500).json({ error: err.message });
  next();
});

module.exports = router;
