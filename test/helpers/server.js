// Start server.js on a spare port with a throwaway DATA_DIR, for the tests
// that need the real thing. Resolves once it's listening.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function startServer({ env = {} } = {}) {
  const port = 3900 + Math.floor(Math.random() * 90);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rota-test-'));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..', '..'),
      env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, TZ: 'Europe/London', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    const timer = setTimeout(() => reject(new Error('server did not start:\n' + log)), 20000);
    const onData = d => {
      log += d;
      if (log.includes('listening on port')) {
        clearTimeout(timer);
        resolve({
          base: `http://127.0.0.1:${port}`,
          dataDir,
          log: () => log,
          stop() { child.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); },
        });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n` + log)); });
  });
}

module.exports = { startServer };
