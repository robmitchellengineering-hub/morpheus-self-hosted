// Apply the ink ladder across src/ — the codemod for the ladder sweep.
//
// WHY THIS EXISTS
//
// Ink became the floor and the rungs above it exist (86401c0), but only one page
// used them. Every `text-ink/N` in the tree is text dimmer than the floor, which
// is the one thing the rule forbids, and every small element sitting at bare
// `text-ink` is text that should be getting MORE contrast than the floor.
//
// It rewrites by exact byte offset and replaces only the colour token, so it
// cannot reformat a file or disturb a variant prefix. The rule it applies is
// scripts/lib/ink-ladder.mjs — the same one verify-prose-ink.mjs enforces.
//
//   node scripts/ink-ladder-sweep.mjs            # dry run, full report
//   node scripts/ink-ladder-sweep.mjs --apply    # write the changes
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { scanLadder, applyLadder, RUNG_FOR } from './lib/ink-ladder.mjs';
import { isDeckFile } from './lib/prose-ink.mjs';

const APPLY = process.argv.includes('--apply');
const root = new URL('..', import.meta.url).pathname;
const files = execFileSync('grep', ['-rlE', 'text-ink', 'src', '--include=*.jsx', '--include=*.js'],
  { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean);

const toRung = {};
const constantsChanged = [];
const unresolved = [];
const dimmed = [];
const constants = [];
let changed = 0;
let touched = 0;
const perFile = {};

for (const rel of files) {
  if (isDeckFile(rel)) continue;
  const src = readFileSync(root + rel, 'utf8');
  const { occurrences, dimmed: d, constants: c } = scanLadder(src);
  for (const x of d) dimmed.push({ rel, ...x });
  for (const x of c) constants.push({ rel, ...x });
  const changes = occurrences.filter((o) => o.token !== o.to);
  for (const o of occurrences) {
    const from = o.token.replace(/\/\d+$/, '') + (o.dim ? ' + opacity' : '');
    toRung[`${from} -> ${o.to}`] = (toRung[`${from} -> ${o.to}`] || 0) + 1;
    if (o.unresolved && o.token !== o.to) unresolved.push(`${rel} ${o.tag} ${o.token} -> ${o.to}`);
  }
  // A class constant has no element, so no size to read — every use site of both
  // `faint` constants resolves to nothing in its ancestor chain. The floor is the
  // safe direction and, unlike leaving them, it removes the opacity modifier the
  // ladder forbids outright. Counted and reported separately so this is visible.
  const constChanges = c.filter((x) => /\/\d+$/.test(x.token));
  for (const x of constChanges) constantsChanged.push({ rel, token: x.token });
  if (!changes.length && !constChanges.length) continue;
  touched++;
  perFile[rel] = changes.length + constChanges.length;
  changed += changes.length;
  if (APPLY) {
    // ONE descending pass. Applying the constants after applyLadder() used stale
    // offsets — the element rewrites had already shifted every byte after them.
    const edits = [
      ...occurrences.filter((o) => o.token !== o.to).map((o) => ({ offset: o.offset, token: o.token, to: o.to })),
      ...constChanges.map((x) => ({ offset: x.offset, token: x.token, to: 'text-ink' })),
    ].sort((a, b) => b.offset - a.offset);
    let next = src;
    for (const e of edits) next = next.slice(0, e.offset) + e.to + next.slice(e.offset + e.token.length);
    if (next !== src) writeFileSync(root + rel, next);
  }
}

console.log(`\nink ladder over ${files.length} files — ${changed} tokens to rewrite in ${touched} files\n`);
console.log(`  ${APPLY ? 'rewritten' : 'would rewrite'}: ${changed}\n`);
const sorted = Object.entries(toRung).sort((a, b) => b[1] - a[1]);
for (const [k, v] of sorted) console.log(`  ${String(v).padStart(5)}  ${k}`);
console.log(`\n  unresolved size (kept at the floor, text-ink): ${unresolved.length}`);
for (const u of unresolved.slice(0, 12)) console.log(`      ${u}`);
console.log(`\n  REPORT ONLY — elements dimmed by an opacity-* utility: ${dimmed.length}`);
for (const x of dimmed.slice(0, 12)) console.log(`      ${x.rel} ${x.tag} ${x.util}`);

console.log(`\n  ink inside a class constant (no element to size): ${constants.length}`);
for (const x of constants.slice(0, 12)) console.log(`      ${x.rel} ${x.token}`);
console.log(`  ...of those, ${constantsChanged.length} carried an opacity modifier and took the floor (text-ink):`);
for (const x of constantsChanged) console.log(`      ${x.rel} ${x.token} -> text-ink`);

if (!APPLY) { console.log('\n  Dry run. Re-run with --apply to write these changes.\n'); process.exit(0); }
console.log('\n  files changed, most first:');
for (const [f, n] of Object.entries(perFile).sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(4)}  ${f}`);
console.log('');
