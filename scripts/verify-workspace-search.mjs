// The construct list must be findable, and must say what it searched.
//
// WHY THIS EXISTS (2026-09-28). Rob went to run the first live deploy and could not find the
// construct: he searched "website test", the construct is called "Web page test", and the box
// matched NAMES ONLY — so the list answered "No constructs match your search." with nothing about
// what it had looked at. A search that silently narrows its scope is how someone concludes their
// work is gone.
//
// The rule now lives in an import-free module so it can be tested here without a browser or a
// database, and this asserts the BEHAVIOUR rather than a regex over JSX: the two things that went
// wrong (name-only matching, and a message that named neither the query nor the scope) are each
// pinned by a case below.
//
// Run:  node scripts/verify-workspace-search.mjs
import { readFileSync } from 'node:fs';
import { matchesConstruct, visibleConstructs, noMatchesMessage, SEARCH_SCOPE } from '../src/lib/constructSearch.js';

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// The real construct that could not be found, with its real description.
const webPageTest = { name: 'Web page test', description: 'Landing page with a contact inquiry form', project_type: 'frontend', updated_date: '2026-09-11T01:49:20.177Z' };

console.log('\n1. a query matches the NAME, as it always did');
check('the exact name matches', matchesConstruct(webPageTest, 'Web page test'), true);
check('a name fragment matches', matchesConstruct(webPageTest, 'web page'), true);
check('…case-insensitively', matchesConstruct(webPageTest, 'WEB PAGE'), true);

console.log('\n2. …and the DESCRIPTION, which is where the intent lives');
check('a description fragment matches', matchesConstruct(webPageTest, 'landing page'), true);
check('…as does a word from the middle of it', matchesConstruct(webPageTest, 'inquiry'), true);
check('an unrelated word still does NOT match — a search that matches everything finds nothing',
  matchesConstruct(webPageTest, 'website'), false);
check('a missing description does not crash', matchesConstruct({ name: 'x' }, 'y'), false);

console.log('\n3. the message names the query AND the scope');
check('it echoes what was typed', /“website”/.test(noMatchesMessage('website')), true);
check('it says what was searched', noMatchesMessage('website').includes(SEARCH_SCOPE), true);
check('it trims the query it quotes', /“x”/.test(noMatchesMessage('  x  ')), true);

console.log('\n4. the list itself: frontend only, matching, in a stable order');
const projects = [
  webPageTest,
  { name: 'Valiant Music', description: 'The Valiant Music WordPress + WooCommerce store', project_type: 'frontend', updated_date: '2026-09-21T00:00:00Z' },
  { name: 'Morpheus Self-Dev', description: 'Live self-development workspace', project_type: 'self_dev', updated_date: '2026-09-28T00:00:00Z' },
  { name: 'Happy birthday Morpheus', description: 'a matrix themed asteroids game', updated_date: '2026-09-02T00:00:00Z' },
];
check('the self-dev workspace is not a construct you build in',
  visibleConstructs(projects, {}).some((p) => p.name === 'Morpheus Self-Dev'), false);
check('an empty query shows everything else', visibleConstructs(projects, {}).length, 3);
check('newest touched first by default',
  visibleConstructs(projects, {}).map((p) => p.name).join(','), 'Valiant Music,Web page test,Happy birthday Morpheus');
check('a construct with no project_type is still shown (old rows have none)',
  visibleConstructs([{ name: 'legacy' }], {}).length, 1);
check('a query filters to matches', visibleConstructs(projects, { query: 'wordpress' }).map((p) => p.name).join(','), 'Valiant Music');
check('…and matching by description works in the list, not just the predicate',
  visibleConstructs(projects, { query: 'asteroids' }).map((p) => p.name).join(','), 'Happy birthday Morpheus');
check('name order when asked',
  visibleConstructs(projects, { sortBy: 'name' }).map((p) => p.name).join(','), 'Happy birthday Morpheus,Valiant Music,Web page test');
check('a non-array is an empty list, not a crash', visibleConstructs(null, {}).length, 0);

console.log('\n5. the workspace uses that rule, and no longer rolls its own');
const ws = read('src/pages/Workspace.jsx');
check('it renders through visibleConstructs', /visibleConstructs\(ws\.projects/.test(ws), true);
check('the name-only filter is gone', /p\.name\.toLowerCase\(\)\.includes/.test(ws), false);
check('the empty state uses the honest message', /noMatchesMessage\(search\)/.test(ws), true);
check('…and the old wording is gone', /No constructs match your search/.test(ws), false);
check('there is a way back to the full list from the dead end', /SHOW ALL CONSTRUCTS/.test(ws), true);

console.log('\n6. this check runs where it is supposed to');
check('it is in verify.mjs\'s HARD list', /'verify-workspace-search\.mjs'/.test(read('scripts/verify.mjs')), true);
check('CI runs it in the guards job (no install)',
  /node scripts\/verify-workspace-search\.mjs/.test(read('.github/workflows/ci.yml')), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) { console.log(`${failures} FAILED\n`); process.exit(1); }
console.log('the construct list is findable, and says what it searched\n');
