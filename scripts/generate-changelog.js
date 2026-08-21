/* ─── Regenerate changelog.json from git history ──────────────────────────
   Run this after every version-bump commit, before pushing:

     node scripts/generate-changelog.js

   Why a generated file instead of reading git at runtime: the production
   Docker image has no .git directory and no git binary (see Dockerfile), so
   server.js can't shell out to git log the way it does for the short commit
   hash. This script does that parsing once, locally, where git is actually
   available, and writes the result to changelog.json — which the Dockerfile
   copies into the image like any other static file.

   One unavoidable lag: the commit that runs this script can't include itself
   in its own output (it hasn't been made yet), so a freshly-generated
   changelog.json is always missing its own commit — that shows up the next
   time this script runs, one version later. Not worth engineering around.
   ───────────────────────────────────────────────────────────────────────── */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const raw = execFileSync(
  'git', ['log', '--date=short', '--pretty=format:%ad|||%B%x00'],
  { cwd: path.join(__dirname, '..'), maxBuffer: 10 * 1024 * 1024 }
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

const outPath = path.join(__dirname, '..', 'changelog.json');
fs.writeFileSync(outPath, JSON.stringify({ generated_at: new Date().toISOString(), entries }, null, 2) + '\n');
console.log(`Wrote ${entries.length} entries to ${outPath}`);
