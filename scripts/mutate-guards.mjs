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
// ⚠️ A MUTATION MARKED `needsInstall` NEEDS THE ROOT `npm ci` (verify-plugin-pack.mjs runs the packer, which
// imports jszip). The no-install guards job cannot run it — its baseline would be red for a reason that has
// nothing to do with the guard — so there it is reported as NEEDS INSTALL rather than run, and the
// `lint + build` job runs exactly those with `--needs-install`. That flag REFUSES to run without an install
// and refuses an empty selection, so the split cannot turn into "ran nowhere" (H17);
// verify-guard-mutations.mjs asserts ci.yml carries the second half.
const onlyNeedsInstall = argv.includes('--needs-install');
const installed = existsSync(join(ROOT, 'node_modules', '.package-lock.json'));
const TIMEOUT_MS = 120_000;

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const tail = (s, n = 14) => String(s || '').split('\n').slice(-n).join('\n');

const selected = MUTATIONS
  .filter((m) => !filters.length || filters.some((f) => m.guard.includes(f)))
  .filter((m) => !onlyNeedsInstall || m.needsInstall);

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
if (onlyNeedsInstall && !installed) {
  console.error('--needs-install was asked for, but there is no root install (node_modules/.package-lock.json) — run npm ci first');
  process.exit(2);
}
if (!filters.length && !onlyNeedsInstall && selected.length < 5) {
  console.error(`only ${selected.length} mutation(s) are registered — that is not a run, it is an empty registry`);
  process.exit(2);
}

// --shard=i/n: run only the i-th of n shards (strided by index), so the ~500-mutation proof can be
// split across parallel runners. The registry floor above still checks the FULL selection — a shard
// legitimately runs fewer than five. A bad shard argument is refused rather than silently ignored.
const shardArg = argv.find((a) => a.startsWith('--shard='));
const shard = shardArg
  ? (() => {
      const [i, n] = shardArg.slice('--shard='.length).split('/').map(Number);
      return (Number.isInteger(i) && Number.isInteger(n) && i >= 0 && i < n) ? { i, n } : null;
    })()
  : null;
if (shardArg && !shard) {
  console.error(`--shard expects i/n (e.g. --shard=0/2), got "${shardArg}"`);
  process.exit(2);
}
const runSelected = shard
  ? selected.filter((_, idx) => idx % shard.n === shard.i)
  : selected;

/** Is this file free of uncommitted changes? Untracked counts as dirty: a crash would lose it. */
function isDirty(file) {
  const r = spawnSync('git', ['status', '--porcelain', '--', file], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) return false; // not a git tree: nothing to lose
  return String(r.stdout || '').trim().length > 0;
}

const dirty = [...new Set(runSelected.map((m) => m.file))].filter(isDirty);
if (dirty.length && !allowDirty) {
  console.error(`refusing to mutate ${dirty.length} file(s) with uncommitted changes:\n  ${dirty.join('\n  ')}`);
  console.error('\nCommit or stash them, or pass --allow-dirty (backups are taken either way).');
  process.exit(2);
}

const backups = mkdtempSync(join(tmpdir(), 'guard-mutations-'));
const results = [];
// The baseline is per-guard, not per-mutation: it runs the guard on the UNMUTATED tree, which is identical
// before every mutation of the same guard (each sabotage is restored before the next). Running it once per
// mutation was the bulk of the ~1,000 node subprocess spawns in a full pass — half of them redundant baseline
// spawns — which is what made a 502-mutation pass ~14 min on a shared runner.
const baselineCache = new Map(); // guard -> spawnSync result
let interrupted = false;
process.on('SIGINT', () => { interrupted = true; });

for (const m of runSelected) {
  if (interrupted) break;
  const abs = resolve(ROOT, m.file);
  const original = readFileSync(abs);
  const originalHash = sha(original);
  const text = original.toString('utf8');

  const count = text.split(m.find).length - 1;
  if (m.needsInstall && !installed) {
    // Staleness is still checked here — it needs no install — so a mutation that stopped matching is caught
    // in both jobs, not only in the one that can run it.
    results.push({ m, verdict: count === 1 ? 'NEEDS INSTALL' : 'STALE', detail: count === 1 ? 'run in lint + build: node scripts/mutate-guards.mjs --needs-install' : `the mutation matches ${count} times` });
    continue;
  }
  if (count === 0) { results.push({ m, verdict: 'STALE', detail: 'the mutation no longer matches' }); continue; }
  if (count > 1) { results.push({ m, verdict: 'STALE', detail: `the mutation matches ${count} times; it must be unique` }); continue; }

  const mutated = text.replace(m.find, m.replace);
  if (mutated === text) { results.push({ m, verdict: 'STALE', detail: 'the mutation changes nothing' }); continue; }

  // Baseline: an assertion that the guard passes BEFORE the sabotage. Without it, a guard that is red for an
  // unrelated reason (a missing dependency, a broken fixture) would be recorded as "caught" forever.
  let base = baselineCache.get(m.guard);
  if (base === undefined) {
    base = spawnSync(process.execPath, [join(ROOT, 'scripts', m.guard)], { cwd: ROOT, encoding: 'utf8', timeout: TIMEOUT_MS });
    baselineCache.set(m.guard, base);
  }
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
    // ⚠️ BEFORE RESTORING, CHECK THAT THE SABOTAGE IS STILL WHAT IS ON DISK. The restore in the `finally` is a
    // blind `writeFileSync(original)` — so if anything else wrote to this file while the guard was running, that
    // write is DESTROYED, and the hash check below cannot see it because it compares the file against the backup
    // that was just put there. That is not hypothetical: a long `--allow-dirty` run left in the background while
    // the file is edited eats the edit silently, and the `--allow-dirty` flag is exactly the case where it
    // happens. If the bytes are not ours any more, leave them alone and say where the backup is.
    const onDisk = readFileSync(abs).toString('utf8');
    if (onDisk !== mutated) {
      writeFileSync(join(backups, `${m.guard}.${m.file.replace(/\//g, '_')}.CONFLICT`), onDisk);
      console.error(`\n!! ${m.file} changed underneath this run, so it was NOT restored.`);
      console.error(`   the sabotage is still in place — put these bytes back by hand:`);
      console.error(`   ${join(backups, `${m.guard}.${m.file.replace(/\//g, '_')}`)}`);
      console.error(`   what was on disk when this was noticed is saved as the .CONFLICT file beside it.`);
      process.exit(4);
    }
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

// ---------------------------------------------------------------------------------------
// the evidence file
// ---------------------------------------------------------------------------------------
// The Valiant SDK counts the DISTINCT guards with a recorded red proof in mutations.json and refuses
// to certify a repo whose guards it cannot see go red. Printing the verdicts to a terminal is not
// evidence anyone else can read, so the run writes them down: one row per mutation, with the verdict
// the guard actually produced. Written only on a full run — a filtered run covers a subset, and
// writing it would delete every other guard's proof.
// A shard is a subset too: writing on --shard=0/n would publish one shard's proof as the whole set.
if (!filters.length && !shard && !onlyNeedsInstall) {
  const proofs = results.map((r) => ({
    guard: r.m.guard,
    mutation: r.m.name,
    file: r.m.file,
    verdict: r.verdict,
    result: r.verdict === 'caught' ? 'red' : r.verdict === 'NEEDS INSTALL' ? 'not-run' : 'green',
    provedBy: 'scripts/mutate-guards.mjs',
    at: new Date().toISOString().slice(0, 10),
  }));
  const dest = resolve(HERE, '..', 'mutations.json');
  writeFileSync(dest, `${JSON.stringify({
    note: 'Generated by scripts/mutate-guards.mjs — do not hand-edit. One row per mutation: result "red" means the guard went red when the thing it claims to protect was broken; "green" is a guard that did not catch its own mutation; "not-run" needed the root install.',
    generatedAt: new Date().toISOString(),
    red: proofs.filter((p) => p.result === 'red').length,
    proofs,
  }, null, 2)}\n`);
  console.log(`proofs: mutations.json written — ${proofs.length} mutation(s), ${proofs.filter((p) => p.result === 'red').length} red`);
}

const deferred = by('NEEDS INSTALL').length;
const bad = results.filter((r) => r.verdict !== 'caught' && r.verdict !== 'NEEDS INSTALL');
console.log(`\n${caught}/${results.length - deferred} guard(s) went red when their subject was broken.`);
if (deferred) console.log(`${deferred} mutation(s) need the root install and were NOT run here — the lint + build job runs them (--needs-install).`);
if (bad.length) {
  const survived = by('SURVIVED').length, stale = by('STALE').length, base = by('BASELINE RED').length, t = by('TIMED OUT').length;
  console.log(`survived: ${survived} · stale: ${stale} · baseline red: ${base} · timed out: ${t}`);
  console.log('\nA guard that survives a broken subject, or whose mutation has gone stale, is not proving anything.');
  console.log(`Backups of every touched file: ${backups}`);
  process.exit(1);
}
console.log('every registered guard fails when the thing it claims to protect is broken\n');
