// Boot the real server and assert it serves /api/health — not a syntax check.
//
// WHY THIS EXISTS — H12, the 2026-09-19 outage
//
// A module was registered in index.js whose import did not resolve. `node
// --check` passed (it validates syntax and never resolves specifiers), lint
// passed, and the unit tests passed — but the container died at module load and
// every API request returned "no healthy upstream" for ~46 minutes. The one
// thing that was never done was booting the server.
//
// This does it, against the local dev database. It cannot see production's
// environment, but the H12 failure was a module-load failure independent of the
// database, so booting against dev catches that entire class. It catches a
// top-level throw, an import that fails to load, and anything else that keeps
// `app.listen` from running — the things CI's other gates are structurally blind
// to.
//
// Run:  node scripts/boot-smoke.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const SERVER = resolve(REPO, 'server');
const PORT = process.env.BOOT_SMOKE_PORT || '4599';
const URL = `http://127.0.0.1:${PORT}/api/health`;
const TIMEOUT_MS = 15000;

const child = spawn(process.execPath, ['src/index.js'], {
  cwd: SERVER,
  env: { ...process.env, NODE_ENV: 'production', PORT },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stderr = '';
let exited = false;
child.stderr.on('data', (d) => { stderr += d; });

const crash = new Promise((resolve) => {
  child.on('exit', (code) => { exited = true; resolve(code); });
});

const deadline = Date.now() + TIMEOUT_MS;
let healthy = false;
while (!exited && Date.now() < deadline) {
  try {
    const res = await fetch(URL);
    if (res.ok) { healthy = true; break; }
  } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 250));
}

if (!healthy) {
  if (exited) {
    const code = await crash;
    console.error(`\n  ✗ the server exited before becoming healthy (exit code ${code}).\n`);
    console.error(`  ${stderr.split('\n').filter(Boolean).slice(-15).join('\n  ')}\n`);
    console.error('  This is exactly what H12 looked like in production.\n');
  } else {
    console.error(`\n  ✗ the server did not serve /api/health within ${TIMEOUT_MS / 1000}s.\n`);
  }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
  process.exit(1);
}

// Healthy — stop it and report.
const res = await fetch(URL);
const body = await res.text();
child.kill('SIGKILL');
await crash;

console.log(`\n  ✓ booted and served /api/health on :${PORT}`);
console.log(`  ${body}\n`);
console.log('  boot smoke test passed\n');
