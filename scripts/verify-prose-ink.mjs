// The prose-ink rule, enforced.
//
// WHY THIS EXISTS
//
// verify-contrast.mjs pins the *tokens* — body copy is ink and headings are
// green. It cannot see the 1,600-odd places that name the green by hand, and
// those are where reading text actually lives. This guard pins the *usage* rule
// that the sweep applied, so it cannot be undone one component at a time — the
// same failure mode verify-contrast was written for.
//
// It asserts the rule from both sides, which matters: a sweep that converted
// everything would pass a "no green prose left" check while destroying the
// brand, and the brand is the point. So this fails BOTH when prose is still
// green AND when the green has been stripped from the titles, labels and
// actions that are supposed to keep it.
//
// It also asserts that the sweep and the guard read the SAME rule. A guard that
// re-implements the rule it is guarding drifts from it, and then the two
// disagree silently — so both scripts are required to import lib/prose-ink.mjs.
//
// Run: node scripts/verify-prose-ink.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scanSource, rawOccurrences, PROTECTED_FILES, PROSE_TAGS, SMALL_SIZE, HEADING_TAGS,
} from './lib/prose-ink.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

let checks = 0;
let failures = 0;
const ok = (name, cond, detail = '') => {
  checks++;
  if (cond) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`); failures++; }
};
const eq = (name, actual, expected) => {
  checks++;
  const a = JSON.stringify(actual); const e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
};

/** Every source file under src/ that can carry JSX. No grep: this must not depend on a shell. */
function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(jsx|js)$/.test(e)) out.push(relative(REPO, p));
  }
  return out;
}
const files = walk(join(REPO, 'src')).sort();

console.log('\nProse-ink rule — the green belongs to titles, the ink to the prose\n');

// ── 1. the scanner accounts for every occurrence ────────────────────────────
// A scanner that silently skips what it cannot parse reports a clean sweep of
// the part it happened to see. That is the failure this section exists to stop.
let rawTotal = 0;
let classifiedTotal = 0;
const unaccounted = [];
const unattributed = [];
for (const rel of files) {
  const src = readFileSync(join(REPO, rel), 'utf8');
  const raw = rawOccurrences(src);
  if (!raw) continue;
  rawTotal += raw;
  const found = scanSource(src);
  classifiedTotal += found.length;
  if (found.length !== raw) unaccounted.push(`${rel}: ${raw} present, ${found.length} classified`);
  for (const o of found) if (o.reason === 'unattributed') unattributed.push(`${rel}:${o.offset}`);
}
ok('source files were scanned (parser sanity)', files.length >= 200, `walked ${files.length} files under src/`);
ok('there are green occurrences to judge (parser sanity)', rawTotal >= 1000, `found ${rawTotal}`);
eq('every text-primary/N is classified exactly once', classifiedTotal, rawTotal);
eq('nothing was left unattributed', unattributed, []);
if (unaccounted.length) console.log(`          ${unaccounted.slice(0, 5).join('\n          ')}`);
eq('no file has an occurrence the scanner could not account for', unaccounted, []);

// ── 2. the sweep is complete over the in-scope files ────────────────────────
// The positive half of the rule: small prose is ink now.
const stillGreen = [];
const counts = { green: 0, ink: 0, sweptInk: 0 };
const byReason = new Map();
const greenOn = { headings: 0, actions: 0, labels: 0, badges: 0 };
const ACTION_TAGS = new Set(['button', 'a', 'link', 'navlink']);
for (const rel of files) {
  const src = readFileSync(join(REPO, rel), 'utf8');
  counts.ink += (src.match(/text-ink(?:\/\d+)?/g) || []).length;
  // The sweep only ever writes the opacity form; bare `text-ink` predates it.
  counts.sweptInk += (src.match(/text-ink\/\d+/g) || []).length;
  if (PROTECTED_FILES.includes(rel)) continue;
  for (const o of scanSource(src)) {
    const key = o.verdict === 'convert' ? 'CONVERT' : o.reason;
    byReason.set(key, (byReason.get(key) || 0) + 1);
    if (o.verdict === 'convert') stillGreen.push(`${rel}:${(src.slice(0, o.offset).match(/\n/g) || []).length + 1} ${o.tag} ${o.token}`);
    counts.green++;
    const tag = String(o.tag).toLowerCase();
    if (HEADING_TAGS.has(tag)) greenOn.headings++;
    else if (ACTION_TAGS.has(tag)) greenOn.actions++;
    if (o.reason === 'uppercase') greenOn.labels++;
    if (o.reason === 'badge') greenOn.badges++;
  }
}
if (stillGreen.length) console.log(`          ${stillGreen.slice(0, 8).join('\n          ')}`);
eq('no small prose still carries the brand green', stillGreen, []);

// ── 3. the brand survived ───────────────────────────────────────────────────
// The negative half. Stripping the green everywhere is a FAILURE of this task,
// not a success, so each class that is supposed to stay green must still have
// green, and green must still be the dominant colour.
// Floors, deliberately: adding a green heading or label is fine and passes, but
// stripping one fails. A floor is the right shape for a convention — growth is
// allowed, erosion is not.
ok('green still marks headings', greenOn.headings >= 5, `headings carrying green: ${greenOn.headings} (5 before this branch; add freely, do not remove)`);
ok('green still marks badges', greenOn.badges >= 1, `badges carrying green: ${greenOn.badges}`);
ok('green still marks uppercase labels', greenOn.labels >= 150, `labels carrying green: ${greenOn.labels} (196 before this branch)`);
ok('green still marks actions (button/a/Link)', greenOn.actions >= 150, `actions carrying green: ${greenOn.actions} (219 before this branch)`);
ok('green is still the majority colour', counts.green > counts.ink,
  `green ${counts.green} vs ink ${counts.ink} — if ink has taken over, the brand is gone`);

// ── 4. the reference page was not swept ────────────────────────────────────
// Alice Stats is the page the convention came from; editing the reference while
// sweeping everything else leaves nothing to compare against.
eq('the reference page is declared protected', PROTECTED_FILES, ['src/pages/AliceStats.jsx']);
{
  const alice = readFileSync(join(REPO, 'src/pages/AliceStats.jsx'), 'utf8');
  const green = rawOccurrences(alice);
  // The swept form is `text-ink/N`; bare `text-ink` was already on this page
  // before the sweep (the big hero numbers use it) and is not evidence of one.
  const swept = (alice.match(/text-ink\/\d+/g) || []).length;
  ok('AliceStats.jsx still carries its 27 green tokens', green === 27, `found ${green}`);
  eq('AliceStats.jsx was not swept (no text-ink/N)', swept, 0);
}

// The sweep has to still be *there*: a guard that only forbids new green would
// pass on a branch where every conversion had been reverted by hand.
ok('the sweep is still applied (text-ink/N is in use)', counts.sweptInk >= 400,
  `text-ink/N occurrences: ${counts.sweptInk}`);

// ── 5. the rule itself has not been quietly widened ────────────────────────
eq('the rule names exactly the approved prose tags', [...PROSE_TAGS].sort(), ['li', 'p', 'span', 'td']);
eq('the approved size range is exactly 9-12px, xs, sm', [
  'text-[9px]', 'text-[10px]', 'text-[11px]', 'text-[12px]', 'text-xs', 'text-sm',
].map((c) => SMALL_SIZE.test(c)), [true, true, true, true, true, true]);
eq('sizes outside the approved range are NOT swept', [
  'text-[8px]', 'text-[13px]', 'text-base', 'text-lg', 'text-xl', 'text-2xl',
].map((c) => SMALL_SIZE.test(c)), [false, false, false, false, false, false]);

// ── 6. the sweep and the guard share one implementation ───────────────────
// Otherwise the guard can pass while the sweep does something else.
for (const script of ['scripts/verify-prose-ink.mjs', 'scripts/prose-ink-sweep.mjs']) {
  const src = readFileSync(join(REPO, script), 'utf8');
  ok(`${script} reads the shared rule`, /from '\.\/lib\/prose-ink\.mjs'/.test(src));
}

console.log(`\n  green left in place: ${counts.green}   ink in use: ${counts.ink} (swept this branch: ${counts.sweptInk})`);
for (const [k, v] of [...byReason].sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(5)}  ${k}`);
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\nThe green/ink convention has drifted. Fix the usage — do not widen the rule or');
  console.log('strip the brand to make this pass.\n');
  process.exit(1);
}
console.log('the prose-ink rule holds.\n');
