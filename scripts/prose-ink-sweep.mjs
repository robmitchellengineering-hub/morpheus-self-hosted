// Apply the prose-ink rule across src/ — the one-shot codemod for the sweep.
//
// WHY THIS EXISTS
//
// 1,632 occurrences of `text-primary/N` in src/ name the brand green explicitly.
// The base layer (4474621) fixed the copy that had no colour class at all; this
// fixes the copy that asks for green by name, using the rule Rob approved on
// 2026-09-22 and reviewed on the pages before merge.
//
// It rewrites by exact byte offset and touches nothing else, so it cannot
// reformat a file, reorder a class list, or move a quote. The classifier it uses
// is scripts/lib/prose-ink.mjs — the same one verify-prose-ink.mjs enforces, so
// the sweep and its guard cannot drift.
//
// Run without --apply to see exactly what it would do.
//
//   node scripts/prose-ink-sweep.mjs            # dry run, full report
//   node scripts/prose-ink-sweep.mjs --apply    # write the changes
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { scanSource, applyConversions, REASONS, isDeckFile } from './lib/prose-ink.mjs';

const APPLY = process.argv.includes('--apply');
const root = new URL('..', import.meta.url).pathname;
const files = execFileSync('grep', ['-rlE', 'text-primary', 'src', '--include=*.jsx', '--include=*.js'],
  { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean);

const byReason = new Map();
const converted = [];
const deckSkipped = [];
let touched = 0;

for (const rel of files) {
  const src = readFileSync(root + rel, 'utf8');
  if (isDeckFile(rel)) { deckSkipped.push(rel); continue; }
  const occ = scanSource(src, rel);
  for (const o of occ) {
    const key = o.verdict === 'convert' ? 'CONVERT' : o.reason;
    byReason.set(key, (byReason.get(key) || 0) + 1);
  }
  const keep = occ.filter((o) => o.verdict === 'convert');
  if (!keep.length) continue;
  touched++;
  converted.push(...keep.map((o) => ({ ...o, rel })));
  if (APPLY) {
    const next = applyConversions(src, occ);
    if (next !== src) writeFileSync(root + rel, next);
  }
}

const total = [...byReason.values()].reduce((a, b) => a + b, 0);
console.log(`\nprose-ink sweep over ${files.length} files — ${total} occurrences of text-primary/N\n`);
console.log(`  ${APPLY ? 'converted' : 'would convert'}: ${converted.length} in ${touched} files`);
if (deckSkipped.length) console.log(`  OUT OF SCOPE (Command Deck, its own theme): ${deckSkipped.join(', ')}`);
console.log('');

const order = ['CONVERT', ...Object.keys(REASONS)];
for (const key of order) {
  const n = byReason.get(key);
  if (!n) continue;
  const label = key === 'CONVERT' ? 'text-primary/N -> text-ink/N' : key;
  const why = key === 'CONVERT' ? '' : `  — ${REASONS[key]}`;
  console.log(`  ${String(n).padStart(5)}  ${label}${why}`);
}
const unknown = [...byReason.keys()].filter((k) => !order.includes(k));
if (unknown.length) { console.log('\n  UNKNOWN REASONS (the vocabulary in lib/prose-ink.mjs needs updating):', unknown); process.exit(1); }

if (!APPLY) {
  console.log('\n  Dry run. Re-run with --apply to write these changes.\n');
  process.exit(0);
}

const perFile = {};
for (const c of converted) perFile[c.rel] = (perFile[c.rel] || 0) + 1;
console.log('\n  files changed, most first:');
for (const [f, n] of Object.entries(perFile).sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(4)}  ${f}`);
console.log('');
