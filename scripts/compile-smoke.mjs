// Smoke-test every compile target by actually RUNNING it on GitHub Actions.
//
// WHY THIS EXISTS
//
// "Make all the compile options work" cannot be answered by reading the
// adapters. Two audits did exactly that and came up clean — while the only hard
// evidence available (a real run log) showed python-package failing every time
// with "PyInstaller produced no .exe" because the verify gate expected a
// Windows extension on a Linux runner. That bug was invisible in the source and
// obvious in the log.
//
// So this generates each target's real workflow, pushes it to a scratch repo,
// dispatches it, and waits for the actual conclusion. It reports what the
// runner says, per target, including the failing step.
//
// USAGE
//
//   node scripts/compile-smoke.mjs --targets web-app,python-package
//   node scripts/compile-smoke.mjs --all --include-expensive
//
// Cost: GitHub Actions minutes, charged per runner — ubuntu is 1x, windows 2x,
// macOS 10x. Hence --all deliberately refuses to include macos/windows targets
// unless --include-expensive is passed. One scratch repo is reused for every
// target (never a repo per attempt — that is the sprawl this codebase just
// finished cleaning up), so this adds exactly one repo.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(REPO, 'server');
const SCRATCH = process.env.SMOKE_REPO || 'robmitchellengineering-hub/morpheus-compile-smoke';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const value = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

const gh = (a, opts = {}) => execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });

// Which seed project each target accepts. Established by asking every adapter's
// own validate()/scaffold() what it requires rather than guessing — the first
// run of this script pushed a Python project at web-app and "found" a failure
// that was purely the fixture's fault.
const SEED = {
  'web-app': 'node',        // requires package.json with a build script
  'python-package': 'py',   // requires a Python file or pyproject.toml (scaffold adds the rest)
  'windows-exe': 'node',    // package.json (Node) or a Python entry point
  'linux-binary': 'node',
  'mac-app': 'node',
  'rpi-distro': 'node',     // accepts anything
  'linux-distro': 'node',   // accepts anything
  // Not yet fixture-able — each needs a real project shape, so they report
  // honestly rather than being run against a project they'd reject:
  //   android-apk       app/src/main/java|kotlin sources + gradle
  //   ios-app           .xcodeproj or Package.swift
  //   arduino-firmware  platformio.ini or .ino
};
const PROJECTS = {
  py: [
    { path: 'main.py', content: 'import sys\n\ndef main():\n    print("morpheus smoke")\n    return 0\n\nif __name__ == "__main__":\n    sys.exit(main())\n' },
    { path: 'requirements.txt', content: '' },
    { path: 'build.py', content: 'print("smoke build")\n' },
  ],
  node: [
    { path: 'package.json', content: JSON.stringify({ name: 'morpheus-smoke', version: '1.0.0', bin: 'cli.js', scripts: { build: 'echo smoke' } }, null, 2) },
    { path: 'cli.js', content: '#!/usr/bin/env node\nconsole.log("morpheus smoke");\n' },
  ],
};

const { listCompileTargets, getCompileTarget } = await import(join(SERVER, 'src/lib/compile-targets/index.js'));
const { renderWorkflow } = await import(join(SERVER, 'src/lib/compile-targets/workflow-renderer.js'));

const requested = value('--targets', '');
let targets = requested ? requested.split(',').map((s) => s.trim()).filter(Boolean) : listCompileTargets();
const expensive = new Set(
  targets.filter((t) => ['macos-latest', 'windows-latest'].includes(getCompileTarget(t)?.runner)),
);
if (!flag('--include-expensive') && expensive.size) {
  targets = targets.filter((t) => !expensive.has(t));
  console.log(`\n  skipping ${[...expensive].join(', ')} — macOS/Windows runners cost 10x/2x minutes.`);
  console.log('  re-run with --include-expensive to include them.\n');
}
if (!targets.length) { console.error('  no targets selected.'); process.exit(1); }

// ── scratch repo ────────────────────────────────────────────────────────────
try { gh(['api', `repos/${SCRATCH}`, '--jq', '.name']); } catch {
  console.log(`  creating scratch repo ${SCRATCH} (private, reused for every target)`);
  gh(['repo', 'create', SCRATCH, '--private', '--description', 'Compile-target smoke tests — generated, safe to delete']);
}
let defaultBranch = 'main';
try { defaultBranch = JSON.parse(gh(['api', `repos/${SCRATCH}`, '--jq', '{b:.default_branch}'])).b; } catch { /* keep main */ }

const put = (path, content, message) => {
  const b64 = Buffer.from(content).toString('base64');
  let sha = null;
  try { sha = JSON.parse(gh(['api', `repos/${SCRATCH}/contents/${path}`, '--jq', '{s:.sha}'])).s; } catch { /* new file */ }
  const a = ['api', '--method', 'PUT', `repos/${SCRATCH}/contents/${path}`, '-f', `message=${message}`, '-f', `content=${b64}`];
  if (sha) a.push('-f', `sha=${sha}`);
  gh(a);
};

async function runTarget(id) {
  const t = getCompileTarget(id);
  if (!t) return { id, verdict: 'UNKNOWN TARGET' };
  const kind = SEED[id];
  if (!kind) return { id, verdict: 'NO FIXTURE YET', detail: 'needs a specialised project shape' };
  const files = PROJECTS[kind];
  const sc = t.scaffold ? t.scaffold(files) : { files };
  const all = sc?.files || files;
  const workflow = renderWorkflow(t.runner, t.buildSteps(all) || [], t.artifact);

  // Push project + workflow.
  for (const f of all) put(f.path, f.content, `smoke: ${id}`);
  put('.github/workflows/build.yml', workflow, `smoke workflow: ${id}`);

  // GitHub needs a moment to register a newly-pushed workflow before dispatch.
  await new Promise((r) => setTimeout(r, 8000));

  const before = JSON.parse(gh(['run', 'list', '-R', SCRATCH, '--limit', '1', '--json', 'databaseId']) || '[]');
  const beforeId = before[0]?.databaseId;

  try { gh(['workflow', 'run', 'build.yml', '-R', SCRATCH, '--ref', defaultBranch]); }
  catch (e) { return { id, runner: t.runner, verdict: 'DISPATCH FAILED', detail: String(e.message).slice(0, 160) }; }

  // Wait for the new run to appear, then for it to finish.
  let runId = null;
  for (let i = 0; i < 20 && !runId; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const runs = JSON.parse(gh(['run', 'list', '-R', SCRATCH, '--limit', '3', '--json', 'databaseId,status']) || '[]');
    runId = runs.find((r) => r.databaseId !== beforeId)?.databaseId || null;
  }
  if (!runId) return { id, runner: t.runner, verdict: 'NO RUN APPEARED' };

  const deadline = Date.now() + 25 * 60 * 1000;
  for (;;) {
    const r = JSON.parse(gh(['run', 'view', String(runId), '-R', SCRATCH, '--json', 'status,conclusion']) || '{}');
    if (r.status === 'completed') {
      if (r.conclusion === 'success') return { id, runner: t.runner, verdict: 'PASS', runId };
      const log = (() => { try { return gh(['run', 'view', String(runId), '-R', SCRATCH, '--log-failed']); } catch { return ''; } })();
      const err = log.split('\n').filter((l) => /##\[error\]|Error:|error:|FAILED|not found|Unable to locate|No such/i.test(l)).slice(-2).join(' | ').slice(0, 200);
      return { id, runner: t.runner, verdict: `FAIL (${r.conclusion})`, runId, detail: err };
    }
    if (Date.now() > deadline) return { id, runner: t.runner, verdict: 'TIMED OUT', runId };
    await new Promise((r) => setTimeout(r, 15000));
  }
}

console.log(`\nCompile-target smoke test — ${targets.length} target(s) on ${SCRATCH}\n`);
const results = [];
for (const id of targets) {
  process.stdout.write(`  ${id.padEnd(20)} running…`);
  const r = await runTarget(id);
  results.push(r);
  process.stdout.write(`\r  ${id.padEnd(20)} ${r.verdict}${r.detail ? '  — ' + r.detail : ''}\n`);
}

console.log('\n  === summary ===');
for (const r of results) console.log(`  ${r.verdict.startsWith('PASS') ? 'PASS' : 'FAIL'}  ${r.id.padEnd(20)} ${r.runner || ''}`);
const failed = results.filter((r) => !r.verdict.startsWith('PASS'));
console.log(`\n  ${results.length - failed.length}/${results.length} passed\n`);
