// Break each guard's subject and confirm the guard goes red.
//
// H19's rule, as a command: *"before believing a green check, break its subject and confirm the check goes
// red. A guard whose failure cannot be demonstrated is a comment with a console.log."*
//
// This applies ONE mutation from scripts/guard-mutations.mjs at a time, runs the guard, and reports:
//
//   baseline red   the guard does not pass on an unmutated tree, so nothing can be concluded from it
//   stale          the mutation no longer matches — the guard is no longer proven, and silence would read
//                  as proof (a mutation that matches twice is refused for the same reason: String.replace
//                  takes the first, so it can mutate the wrong site and still go red)
//   caught         the guard failed, as it must
//   SURVIVED       the guard passed with its subject broken — the failure this whole file exists to find
//
// SAFETY. Each touched file is backed up in memory and on disk, restored in a `finally`, and its hash is
// verified against the original afterwards. Nothing is ever restored with `git checkout`, so a file with
// uncommitted work is safe — but the run still refuses to start on a dirty file unless `--allow-dirty`,
// because a SIGKILL mid-run is the one case a `finally` cannot cover, and the backup path is printed when
// that happens.
//
// Run:  node scripts/mutate-guards.mjs                 every registered mutation
//       node scripts/mutate-guards.mjs verify-cors     only guards matching a substring
//       node scripts/mutate-guards.mjs --list          what is registered, without running anything
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { MUTATIONS } from './guard-mutations.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const allowDirty = argv.includes('--allow-dirty');
const filters = argv.filter((a) => !a.startsWith('--'));
const TIMEOUT_MS = 120_000;

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const tail = (s, n = 14) => String(s || '').split('\n').slice(-n).join('\n');

const selected = MUTATIONS.filter((m) => !filters.length || filters.some((f) => m.guard.includes(f)));

if (argv.includes('--list')) {
  for (const m of selected) console.log(`${m.guard.padEnd(32)} ${m.file}`);
  console.log(`\n${selected.length} of ${MUTATIONS.length} registered mutation(s)`);
  process.exit(0);
}
if (!selected.length) {
  console.error(`no mutation matches ${filters.join(', ')} — see --list`);
  process.exit(2);
}
// A run that proves NOTHING must not report success. Without this, an emptied registry would print "0/0
// guard(s) went red" and exit 0 — green, having examined nothing, which is H17 in the one place this file is
// supposed to be the cure for it. `verify-guard-mutations.mjs` refuses an emptied registry too, via the
// ratchet, but this tool is run by hand as well and must not lie on its own.
//
// The floor applies only to a FULL run: naming a guard is a deliberate, narrow question ("did my new entry
// really land?"), and that is a legitimate one-mutation run.
if (!filters.length && selected.length < 5) {
  console.error(`only ${selected.length} mutation(s) are registered — that is not a run, it is an empty registry`);
  process.exit(2);
}

/** Is this file free of uncommitted changes? Untracked counts as dirty: a crash would lose it. */
function isDirty(file) {
  const r = spawnSync('git', ['status', '--porcelain', '--', file], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) return false; // not a git tree: nothing to lose
  return String(r.stdout || '').trim().length > 0;
}

const dirty = [...new Set(selected.map((m) => m.file))].filter(isDirty);
if (dirty.length && !allowDirty) {
  console.error(`refusing to mutate ${dirty.length} file(s) with uncommitted changes:\n  ${dirty.join('\n  ')}`);
  console.error('\nCommit or stash them, or pass --allow-dirty (backups are taken either way).');
  process.exit(2);
}

const backups = mkdtempSync(join(tmpdir(), 'guard-mutations-'));
const results = [];
let interrupted = false;
process.on('SIGINT', () => { interrupted = true; });

for (const m of selected) {
  if (interrupted) break;
  const abs = resolve(ROOT, m.file);
  const original = readFileSync(abs);
  const originalHash = sha(original);
  const text = original.toString('utf8');

  const count = text.split(m.find).length - 1;
  if (count === 0) { results.push({ m, verdict: 'STALE', detail: 'the mutation no longer matches' }); continue; }
  if (count > 1) { results.push({ m, verdict: 'STALE', detail: `the mutation matches ${count} times; it must be unique` }); continue; }

  const mutated = text.replace(m.find, m.replace);
  if (mutated === text) { results.push({ m, verdict: 'STALE', detail: 'the mutation changes nothing' }); continue; }

  // Baseline: an assertion that the guard passes BEFORE the sabotage. Without it, a guard that is red for an
  // unrelated reason (a missing dependency, a broken fixture) would be recorded as "caught" forever.
  const base = spawnSync(process.execPath, [join(ROOT, 'scripts', m.guard)], { cwd: ROOT, encoding: 'utf8', timeout: TIMEOUT_MS });
  if (base.status !== 0) {
    results.push({ m, verdict: 'BASELINE RED', detail: base.error ? String(base.error.message) : `exit ${base.status}`, output: tail(base.stdout) });
    continue;
  }

  // Back up to disk as well as memory: if this process is killed, the file is still recoverable by hand.
  writeFileSync(join(backups, `${m.guard}.${m.file.replace(/\//g, '_')}`), original);
  let verdict, detail, output;
  try {
    writeFileSync(abs, mutated);
    const run = spawnSync(process.execPath, [join(ROOT, 'scripts', m.guard)], { cwd: ROOT, encoding: 'utf8', timeout: TIMEOUT_MS });
    if (run.error && run.error.code === 'ETIMEDOUT') { verdict = 'TIMED OUT'; detail = `${TIMEOUT_MS}ms`; }
    else if (run.status === 0) { verdict = 'SURVIVED'; output = tail(run.stdout); }
    else { verdict = 'caught'; detail = `exit ${run.status}`; }
  } finally {
    writeFileSync(abs, original);
    const after = sha(readFileSync(abs));
    if (after !== originalHash) {
      console.error(`\n!! ${m.file} DID NOT RESTORE. Original bytes are in ${backups}/`);
      process.exit(3);
    }
  }
  results.push({ m, verdict, detail, output });
}

const by = (v) => results.filter((r) => r.verdict === v);
const caught = by('caught').length;

console.log('');
for (const r of results) {
  const mark = r.verdict === 'caught' ? 'caught  ' : `${r.verdict}  `;
  console.log(`  ${mark.padEnd(14)} ${r.m.guard.padEnd(30)} ${r.detail || ''}`);
  // The failure is the evidence: print what the guard said while its subject was broken.
  if (r.verdict === 'SURVIVED' && r.output) console.log(r.output.split('\n').map((l) => `                 ${l}`).join('\n'));
}

const bad = results.filter((r) => r.verdict !== 'caught');
console.log(`\n${caught}/${results.length} guard(s) went red when their subject was broken.`);
if (bad.length) {
  const survived = by('SURVIVED').length, stale = by('STALE').length, base = by('BASELINE RED').length, t = by('TIMED OUT').length;
  console.log(`survived: ${survived} · stale: ${stale} · baseline red: ${base} · timed out: ${t}`);
  console.log('\nA guard that survives a broken subject, or whose mutation has gone stale, is not proving anything.');
  console.log(`Backups of every touched file: ${backups}`);
  process.exit(1);
}
console.log('every registered guard fails when the thing it claims to protect is broken\n');
