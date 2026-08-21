/* ─── Regenerate changelog.json from git history ──────────────────────────
   Run this after every version-bump commit, before pushing:

     node scripts/generate-changelog.js

   Why a generated file instead of reading git at runtime: the production
   Docker image has no .git directory and no git binary (see Dockerfile), so
   server.js can't shell out to git at all — not for the change history, and
   not for the short commit hash it used to show next to the version number
   either. This script does both once, locally, where git is actually
   available, and writes the result to changelog.json — which the Dockerfile
   copies into the image like any other static file.

   One unavoidable lag, for both the entries and the commit hash: the commit
   that runs this script can't know its own hash or include itself in the
   changelog (neither exists yet at generation time) — both are one commit
   behind until the *next* time this script runs. Not worth engineering
   around — two commits just to stamp a hash accurately isn't worth it for
   what's fundamentally a "does this look like a recent deploy" sanity check.
   ───────────────────────────────────────────────────────────────────────── */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');

const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT }).toString().trim();

const raw = execFileSync(
  'git', ['log', '--date=short', '--pretty=format:%ad|||%B%x00'],
  { cwd: REPO_ROOT, maxBuffer: 10 * 1024 * 1024 }
).toString();

const entries = raw.split('\x00')
  .map(chunk => chunk.trim())
  .filter(Boolean)
  .map(chunk => {
    const sep = chunk.indexOf('|||');
    if (sep === -1) return null;
    const date = chunk.slice(0, sep);
    const body = chunk.slice(sep + 3).trim();
    const lines = body.split('\n');
    const m = lines[0].match(/^v(\d+\.\d+\.\d+):\s*(.+)$/);
    if (!m) return null;
    const details = lines.slice(1).join('\n')
      .replace(/^Co-Authored-By:.*$/gim, '')
      .trim();
    return { version: m[1], date, summary: m[2], details };
  })
  .filter(Boolean);

const outPath = path.join(REPO_ROOT, 'changelog.json');
fs.writeFileSync(outPath, JSON.stringify({ generated_at: new Date().toISOString(), commit, entries }, null, 2) + '\n');
console.log(`Wrote ${entries.length} entries (commit ${commit}) to ${outPath}`);
