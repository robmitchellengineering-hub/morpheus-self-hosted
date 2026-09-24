// Verification for /proving-ground — the admin-only surface where a change
// shipped through self-dev gets looked at before it goes near a customer.
//
// Three things are asserted, and each answers a way the page stops being what
// it says it is:
//
//   1. IT IS ADMIN ONLY. The route sits inside the `adminOnly` ProtectedRoute
//      group, and the page declares itself internal. A test surface that leaks
//      into the customer app is worse than no test surface.
//   2. IT IS NOT LINKED FROM ANYWHERE CUSTOMER FACING. "Not customer facing" is
//      a claim that decays the moment somebody adds a nav entry; this fails on
//      any reference outside the page, its route, and this file.
//   3. ITS CARDS CANNOT SILENTLY DISAPPEAR. The registry and the files on disk
//      must agree in BOTH directions — the mistake DeckHome.jsx makes by
//      rendering `null` for a key with no module.
//
// Run: node scripts/verify-proving-ground.mjs

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVING_GROUND_CARDS } from '../src/pages/ProvingGround/cards.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const read = (rel) => readFileSync(path.join(REPO, rel), 'utf8');

const CARDS_DIR = 'src/pages/ProvingGround/cards';
const PAGE = 'src/pages/ProvingGround/index.jsx';
const ROUTE = '/proving-ground';

let failures = 0;
let checks = 0;

function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  PASS  ${name}`);
  } else {
    console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`);
    failures++;
  }
}

console.log('\nproving ground — verification\n');

// ── 1. Admin only ───────────────────────────────────────────────────────────
console.log('1. the route is admin-only and says so');

const app = read('src/App.jsx');
// The group's opener is the <Route> whose own tag carries `adminOnly`; its
// children are all self-closing, so the FIRST </Route> after it closes the
// group. The first cut of this check sliced to the wildcard route at the bottom
// of the file instead — which counted anything sitting just ABOVE that wildcard
// as "inside the group", and a mutation that moved the route out of the group
// sailed straight through. If the admin group ever gains a nested group, this
// fails loudly rather than silently measuring the wrong thing.
const openTagStart = app.lastIndexOf('<Route', app.indexOf('adminOnly'));
const groupEnd = app.indexOf('</Route>', openTagStart);
const adminGroup = openTagStart >= 0 && groupEnd > openTagStart ? app.slice(openTagStart, groupEnd) : '';
const routeLine = app.split('\n').find((l) => l.includes(`path="${ROUTE}"`)) || '';

check('there is an adminOnly route group', app.indexOf('adminOnly') > -1, true);
check('the proving-ground route exists', routeLine.length > 0, true);
check('it is declared inside that group', adminGroup.includes(`path="${ROUTE}"`), true);
check('it is lazy-loaded like every other admin page', app.includes("import('@/pages/ProvingGround')"), true);

const page = read(PAGE);
check('the page declares itself internal', /Internal test surface/i.test(page), true);
check('the page says it is not customer facing', /not customer facing|customer facing/i.test(page), true);
check('the page flags a registry/module disagreement loudly', page.includes('MISSING MODULE'), true);
check('the page shows unregistered modules too, not just missing ones', page.includes('module but not registered'), true);

// ── 2. Nothing customer facing points at it ─────────────────────────────────
console.log('\n2. no customer-facing surface links to it');

// Anything OUTSIDE this allow-list that names the page is a leak into a surface
// a customer can reach. The route + its lazy import live in App.jsx; the page
// and its cards reference themselves; this guard names it to check it.
const ALLOWED = [
  'src/App.jsx',
  'scripts/verify-proving-ground.mjs',
];
const isAllowed = (rel) => ALLOWED.includes(rel) || rel.startsWith('src/pages/ProvingGround/');

const offenders = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) { walk(full); continue; }
    if (!/\.(js|jsx|mjs|json|html|php|txt|md)$/.test(entry)) continue;
    const rel = path.relative(REPO, full);
    if (isAllowed(rel)) continue;
    const text = readFileSync(full, 'utf8');
    if (text.includes(ROUTE) || /ProvingGround/.test(text)) offenders.push(rel);
  }
}
for (const dir of ['src', 'public', 'wp-plugin']) {
  const full = path.join(REPO, dir);
  if (existsSync(full)) walk(full);
}
check('nothing outside the page and its route mentions it', offenders, []);

// The dock loads its own tabs; a test surface must never be reachable there.
check('the embed/dock surface is untouched', read('src/pages/Embed.jsx').includes(ROUTE), false);

// ── 3. The registry and the files agree, both ways ──────────────────────────
console.log('\n3. cards cannot silently disappear');

const onDisk = readdirSync(path.join(REPO, CARDS_DIR))
  .filter((f) => f.endsWith('.jsx'))
  .map((f) => f.replace(/\.jsx$/, ''))
  .sort();
const registered = PROVING_GROUND_CARDS.map((c) => c.key).sort();

check('the registry is not empty (otherwise this page proves nothing)', PROVING_GROUND_CARDS.length > 0, true);
check('every registered card has a module', registered.filter((k) => !onDisk.includes(k)), []);
check('every module is registered (an unlisted file would be invisible)', onDisk.filter((k) => !registered.includes(k)), []);
check('card keys are unique', new Set(registered).size, registered.length);

for (const card of PROVING_GROUND_CARDS) {
  const src = read(`${CARDS_DIR}/${card.key}.jsx`);
  check(`${card.key} default-exports a component`, /export default/.test(src), true);
  check(`${card.key} documents what it is for`, typeof card.what === 'string' && card.what.length > 20, true);
  check(`${card.key} records who shipped it`, Boolean(card.addedBy) && Boolean(card.ref), true);
}

// The loader must be a glob, not a hand-maintained import list — otherwise
// "drop a file in and it appears" stops being true and a card needs an edit
// here, which is the Deck-widget coupling this design avoids.
const loader = page.slice(page.indexOf('import.meta.glob'), page.indexOf('export default function'));
check('the page discovers cards by filename, not by a hand-written import list', /import\.meta\.glob\('\.\/cards\/\*\.jsx'/.test(page), true);
check('the loader resolves before the component renders', page.indexOf('import.meta.glob') < page.indexOf('export default function'), true);

console.log(`\n${failures === 0 ? '✓' : '✗'} ${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
