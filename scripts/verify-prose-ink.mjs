// The prose-ink rule, enforced.
//
// WHY THIS EXISTS
//
// verify-contrast.mjs pins the *tokens* — body copy is ink and headings are
// green. It cannot see the 2,500-odd places that name the green by hand, and
// those are where reading text actually lives. This guard pins the *usage* rule
// the sweep applied, so it cannot be undone one component at a time.
//
// It asserts the rule from BOTH sides. A sweep that converted everything would
// pass a "no green prose left" check while destroying the brand, and the brand is
// the point — green has to keep meaning something. So this fails when prose is
// still green AND when green has been stripped from the headings, labels, badges,
// actions, metrics and inline emphasis that are supposed to keep it.
//
// An earlier version asserted "green still outnumbers ink" as a proxy for "the
// brand survives". That is gone. It was a proxy for a real intent but not the
// intent, it would have gone false the moment the sweep did its job properly, and
// a guard that measures the wrong thing is worse than one that measures nothing.
//
// It still asserts that the sweep and the guard read the SAME rule, because a
// guard that re-implements the rule it guards drifts from it silently.
//
// Run: node scripts/verify-prose-ink.mjs

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scanSource, rawOccurrences, isDeckFile, DECK_PATHS, KNOWN_GREEN_CONSTANTS,
  PROSE_TAGS, ACTION_TAGS, FIELD_TAGS, HEADING_TAGS, EMPHASIS_TAGS,
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

console.log('\nProse-ink rule — the green belongs to structure, the ink to the prose\n');

// ── 1. the scanner accounts for every occurrence ────────────────────────────
// A scanner that silently skips what it cannot parse reports a clean sweep of the
// part it happened to see. That is the failure this section exists to stop — and
// it is not hypothetical: a regex literal in SyntaxHighlighter.jsx blanked 60
// lines and hid a real className, which then filed itself under "class-constant"
// and looked harmless.
let rawTotal = 0;
let classifiedTotal = 0;
const unaccounted = [];
const unattributed = [];
for (const rel of files) {
  const src = readFileSync(join(REPO, rel), 'utf8');
  const raw = rawOccurrences(src);
  if (!raw) continue;
  rawTotal += raw;
  const found = scanSource(src, rel);
  classifiedTotal += found.length;
  if (found.length !== raw) unaccounted.push(`${rel}: ${raw} present, ${found.length} classified`);
  for (const o of found) if (o.reason === 'unattributed') unattributed.push(`${rel}:${o.offset}`);
}
ok('source files were scanned (parser sanity)', files.length >= 200, `walked ${files.length} files under src/`);
// The population shrinks as the sweep converts tokens to ink, so this cannot be a
// fixed number near the original count — it only has to prove the census looked at
// a real codebase rather than an empty scan.
ok('there are occurrences to judge (parser sanity)', rawTotal >= 1000, `found ${rawTotal} still on text-primary`);
eq('every text-primary occurrence is classified exactly once', classifiedTotal, rawTotal);
if (unattributed.length) console.log(`          ${unattributed.slice(0, 6).join('\n          ')}`);
eq('nothing was left unattributed', unattributed, []);
if (unaccounted.length) console.log(`          ${unaccounted.slice(0, 5).join('\n          ')}`);
eq('no file has an occurrence the scanner could not account for', unaccounted, []);

// ── 2. the sweep is complete: ink carries prose ─────────────────────────────
const stillGreen = [];
const counts = { green: 0, sweptInk: 0, ink: 0 };
const byReason = new Map();
const greenOn = { headings: 0, actions: 0, labels: 0, badges: 0, metrics: 0, titles: 0, emphasis: 0 };
const ACTION_TAG_NAMES = new Set(['button', 'a', 'link', 'navlink']);
for (const rel of files) {
  if (isDeckFile(rel)) continue;
  const src = readFileSync(join(REPO, rel), 'utf8');
  counts.ink += (src.match(/text-ink(?:\/\d+)?/g) || []).length;
  counts.sweptInk += (src.match(/text-ink\/\d+/g) || []).length;
  for (const o of scanSource(src, rel)) {
    byReason.set(o.reason, (byReason.get(o.reason) || 0) + 1);
    if (o.verdict === 'convert') {
      stillGreen.push(`${rel}:${src.slice(0, o.offset).split('\n').length} ${o.tag} ${o.token}`);
      continue;
    }
    counts.green++;
    const tag = String(o.tag).toLowerCase();
    if (HEADING_TAGS.has(tag)) greenOn.headings++;
    else if (ACTION_TAG_NAMES.has(tag) || ACTION_TAGS.has(tag)) greenOn.actions++;
    else if (EMPHASIS_TAGS.has(tag)) greenOn.emphasis++;
    if (o.reason === 'uppercase' || o.reason === 'text-capitals' || o.reason === 'runtime-capitals' || o.reason === 'title-tracking') greenOn.labels++;
    if (o.reason === 'badge') greenOn.badges++;
    if (o.reason === 'number-like') greenOn.metrics++;
    if (o.reason === 'title-weight' || o.reason === 'title-size') greenOn.titles++;
  }
}
if (stillGreen.length) console.log(`          ${stillGreen.slice(0, 8).join('\n          ')}`);
eq('no in-rule prose still carries the brand green', stillGreen, []);

// ── 3. green still means something ──────────────────────────────────────────
// Floors, deliberately: adding a green heading or label passes, stripping one
// fails. That is the right shape for a convention — growth is allowed, erosion is
// not. The point is that the brand did not get flattened into white.
// Pinned at the counts this branch produced, because a floor far below the real
// number cannot see the failure it is meant to see: with 18 green headings and a
// floor of 5, converting one heading is invisible. Growth still passes; ANY
// reduction fails, and the message says what to do about it.
const FLOORS = { headings: 18, titles: 86, labels: 379, badges: 4, actions: 760, metrics: 19, emphasis: 7 };
ok('green still marks headings', greenOn.headings >= FLOORS.headings, `headings: ${greenOn.headings} (pinned ${FLOORS.headings})`);
ok('green still marks titles and headline sizes', greenOn.titles >= FLOORS.titles, `titles: ${greenOn.titles} (pinned ${FLOORS.titles})`);
ok('green still marks uppercase / runtime labels', greenOn.labels >= FLOORS.labels, `labels: ${greenOn.labels} (pinned ${FLOORS.labels})`);
ok('green still marks badges', greenOn.badges >= FLOORS.badges, `badges: ${greenOn.badges} (pinned ${FLOORS.badges})`);
ok('green still marks controls and structure (button/a/summary/th)', greenOn.actions >= FLOORS.actions, `controls: ${greenOn.actions} (pinned ${FLOORS.actions})`);
ok('green still marks metrics and counters', greenOn.metrics >= FLOORS.metrics, `metrics: ${greenOn.metrics} (pinned ${FLOORS.metrics})`);
ok('green still marks inline emphasis', greenOn.emphasis >= FLOORS.emphasis, `emphasis: ${greenOn.emphasis} (pinned ${FLOORS.emphasis})`);
ok('the sweep is still applied (text-ink/N is in use)', counts.sweptInk >= 700, `text-ink/N: ${counts.sweptInk}`);

// ── 4. the class-constant decisions are pinned ──────────────────────────────
// A class string in a constant has no tag to read, so it cannot be classified —
// only decided. Pinning the set means a NEW constant fails this guard and has to
// be looked at, instead of quietly leaving prose green.
const constants = new Set();
for (const rel of files) {
  if (isDeckFile(rel)) continue;
  for (const o of scanSource(readFileSync(join(REPO, rel), 'utf8'), rel)) {
    if (o.reason === 'class-constant' && o.owner) constants.add(`${rel}|${o.owner}`);
  }
}
const known = new Set(KNOWN_GREEN_CONSTANTS);
const undecided = [...constants].filter((c) => !known.has(c)).sort();
const stale = [...known].filter((c) => !constants.has(c)).sort();
ok('class-constant declarations were found (parser sanity)', constants.size >= 20, `found ${constants.size}`);
eq('every green class-constant has been decided', undecided, []);
eq('the decided list has no stale entries', stale, []);

// ── 5. the Deck is its own theme and is untouched ───────────────────────────
// Rob, 2026-09-23: "command deck is its own theme please dont change it".
ok('the Deck paths are declared', DECK_PATHS.length >= 4, DECK_PATHS.join(', '));
const deckFiles = [];
for (const p of DECK_PATHS) {
  const full = join(REPO, p);
  if (!existsSync(full)) continue;
  if (p.endsWith('/')) {
    const walkDeck = (d) => {
      for (const e of readdirSync(d)) {
        const q = join(d, e);
        if (statSync(q).isDirectory()) walkDeck(q);
        else if (/\.(jsx|js)$/.test(e)) deckFiles.push(relative(REPO, q));
      }
    };
    walkDeck(full);
  } else if (/\.(jsx|js)$/.test(p)) deckFiles.push(p);
}
ok('the Deck files were found (parser sanity)', deckFiles.length >= 10, `found ${deckFiles.length}`);
const deckInked = deckFiles.filter((f) => /text-ink/.test(readFileSync(join(REPO, f), 'utf8')));
eq('no Deck file was swept (no text-ink token anywhere in the Deck)', deckInked, []);
{
  // The rule itself must refuse the Deck, not merely be skipped by the sweep.
  const probe = scanSource('<p className="text-primary/60 text-primary">words</p>', 'src/pages/CommandDeck/DeckUI.jsx');
  eq('the rule refuses a Deck file outright', probe.map((o) => o.reason), ['deck-own-theme', 'deck-own-theme']);
  const external = scanSource('<p className="text-primary/60">words</p>', 'src/pages/Landing.jsx');
  eq('the same markup outside the Deck is in scope', external.map((o) => o.verdict), ['convert']);
}
{
  const palette = readFileSync(join(REPO, 'src/pages/CommandDeck/deckConstants.js'), 'utf8');
  ok('the Deck keeps its own Tweed & Walnut palette',
    /export const C = \{/.test(palette) && /tweed:\s*'#[0-9A-Fa-f]{6}'/.test(palette) && /walnut:\s*'#[0-9A-Fa-f]{6}'/.test(palette));
}

// ── 6. the rule shape cannot be quietly narrowed again ──────────────────────
eq('the prose tags include the ones the size gate used to hide',
  ['div', 'li', 'p', 'pre', 'span', 'td'].every((t) => PROSE_TAGS.has(t)), true);
eq('buttons, links, disclosure and table headers stay green',
  ['a', 'button', 'summary', 'th'].every((t) => ACTION_TAGS.has(t)), true);
eq('form fields are OUT of the keep-green set (Rob, 2026-09-23)',
  ['input', 'textarea', 'select'].every((t) => !ACTION_TAGS.has(t) && FIELD_TAGS.has(t)), true);
eq('a form label is prose now', PROSE_TAGS.has('label') && !ACTION_TAGS.has('label'), true);
{
  // The decision itself, as behaviour rather than as membership.
  const probe = (src) => scanSource(src, 'src/pages/Landing.jsx').map((o) => o.verdict === 'convert' ? 'convert' : o.reason);
  eq('a field value converts', probe('<input className="text-primary/70" />'), ['convert']);
  eq('a placeholder converts with it', probe('<input className="placeholder:text-primary/20" />'), ['convert']);
  eq('a form label converts', probe('<label className="text-primary/60">API key</label>'), ['convert']);
  eq('a textarea converts', probe('<textarea className="text-primary/70" />'), ['convert']);
  eq('a button still stays green', probe('<button className="text-primary/60">Save</button>'), ['action-tag']);
  eq('a disclosure control still stays green', probe('<summary className="text-primary/60">More</summary>'), ['action-tag']);
  eq('a table header still stays green', probe('<th className="text-primary/60">Name</th>'), ['action-tag']);
}
{
  // A prose host with NO size class must convert: that was the whole complaint.
  const noSize = scanSource('<p className="text-primary/60 leading-relaxed">Some prose.</p>', 'src/pages/Landing.jsx');
  eq('a size-less paragraph still converts', noSize.map((o) => o.verdict), ['convert']);
}
{
  // A runtime label must NOT convert: `{label.toUpperCase()}` is invisible to a
  // source-level capitals test, which is how the rule got this wrong.
  const runtime = scanSource('<p className="text-primary/50">{label.toUpperCase()}</p>', 'src/pages/Landing.jsx');
  eq('a runtime-uppercased label stays green', runtime.map((o) => o.reason), ['runtime-capitals']);
}
{
  const emphasis = scanSource('<strong className="text-primary">word</strong>', 'src/pages/Landing.jsx');
  eq('inline emphasis stays green', emphasis.map((o) => o.reason), ['inline-emphasis']);
}

// ── 7. Alice Stats: its prose is ink, its runtime labels are still green ────
{
  const alice = readFileSync(join(REPO, 'src/pages/AliceStats.jsx'), 'utf8');
  const swept = (alice.match(/text-ink\/\d+/g) || []).length;
  const labels = scanSource(alice, 'src/pages/AliceStats.jsx')
    .filter((o) => o.reason === 'runtime-capitals').length;
  ok('Alice Stats prose was swept into ink', swept >= 6, `text-ink/N: ${swept}`);
  ok("Alice Stats' {x.toUpperCase()} labels kept their green", labels === 2, `runtime labels still green: ${labels}`);
}

// ── 8. the sweep and the guard share one implementation ────────────────────
for (const script of ['scripts/verify-prose-ink.mjs', 'scripts/prose-ink-sweep.mjs']) {
  const src = readFileSync(join(REPO, script), 'utf8');
  ok(`${script} reads the shared rule`, /from '\.\/lib\/prose-ink\.mjs'/.test(src));
}

console.log(`\n  green kept: ${counts.green}   ink in use: ${counts.ink} (swept this branch: ${counts.sweptInk})`);
console.log(`  headings ${greenOn.headings} · titles ${greenOn.titles} · labels ${greenOn.labels} · badges ${greenOn.badges} · actions ${greenOn.actions} · metrics ${greenOn.metrics}`);
for (const [k, v] of [...byReason].sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(5)}  ${k}`);
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\nThe green/ink convention has drifted. Fix the usage — do not widen the rule,');
  console.log('convert the Deck, or strip the brand to make this pass.\n');
  process.exit(1);
}
console.log('the prose-ink rule holds.\n');
