// Does deleting a widget take its backend endpoint with it — and is no endpoint
// left behind without a widget?
//
// WHY THIS EXISTS. A Jarvis widget build may create ONE backend endpoint at
// `server/src/functions/widget<PascalCase>.js` (buildDeckWidget.js's authoring
// contract; enginePolicy.js's WIDGET_BUILD allow-list). A file under
// `server/src/functions/` is ROUTED JUST BY EXISTING — routes/functions.routes.js
// loads `functions/<name>.js` on demand, with no registry to remove — so an
// endpoint whose widget was deleted is not dead code, it is live, reachable
// surface that answers 401 instead of 404.
//
// That shipped. PR #439 removed the "Energy sparkline" widget's .jsx and its one
// DECK_WIDGETS line and left `server/src/functions/widgetEnergySparkline.js`
// behind; it was removed by hand a day later (`1a1922b`), whose own message
// records "the gap that produced it" as still open and wanting "its own guard".
// This is that guard.
//
// THE CLAIM: every `server/src/functions/widget*.js` is invoked by a widget under
// `src/pages/CommandDeck/widgets/`. That is the true reference direction — the
// build is scoped to the widget's .jsx, its endpoint and the registry line, so it
// cannot wire the endpoint into CommandDeckContext.jsx; the endpoint is invoked
// from the widget's own source. The historical orphan fails it exactly.
//
// ⚠️ IT ASSERTS BEHAVIOUR, NOT SPELLING (H19). The rule lives in
// lib/widgetBackendFunctions.js as pure functions, and sections 1 pins them
// against the REAL incident as a fixture — not against the words this file
// happens to contain. Section 3 asserts the CALL is wired, because a rule nothing
// calls is H17.
//
// Run:  node scripts/verify-deck-widget-backend.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  widgetBackendReferences, orphanWidgetFunctions, widgetFunctionsToRemove,
} from '../server/src/lib/widgetBackendFunctions.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(REPO, p), 'utf8');
// Comments are stripped before any source assertion: every name below appears in
// the prose of the files it is asserted against, and a name mentioned in a comment
// is not wiring (H19 records six guards satisfied by their own prose).
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const WIDGETS_DIR = 'src/pages/CommandDeck/widgets';
const FUNCTIONS_DIR = 'server/src/functions';

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

console.log('\n1. the rule, pinned against the incident that produced it');
// The invocation shape the build contract produces (the real widget did exactly
// this), including the streaming form.
check('an invoke() names the endpoint',
  widgetBackendReferences("const r = await base44.functions.invoke('widgetEnergySparkline', { days: 30 });"),
  ['widgetEnergySparkline']);
check('invokeStream() names it too',
  widgetBackendReferences("await base44.functions.invokeStream('widgetTwo', {});"), ['widgetTwo']);
check('names are de-duplicated and sorted',
  widgetBackendReferences("invoke('widgetB', {}); invoke('widgetA', {}); invoke('widgetB', {});"),
  ['widgetA', 'widgetB']);
// ⚠️ The real widget's header NAMED its backend file in a comment. A reference
// that is only prose must not keep an orphan alive — nor be treated as a call.
check('a name mentioned only in a comment is NOT a reference',
  widgetBackendReferences("// server/src/functions/widgetEnergySparkline.js reads the same entity\n"),
  []);
check('a non-widget function is never this widget\'s to remove',
  widgetBackendReferences("base44.functions.invoke('deleteDeckWidget', { key: 'x' });"), []);

// THE INCIDENT, as a fixture: the endpoint exists, the widget that invoked it is
// gone. This is the assertion that goes red if orphan detection stops working.
const INCIDENT_FUNCTIONS = ['widgetEnergySparkline'];
const INCIDENT_WIDGETS = ['// a different widget; nothing invokes widgetEnergySparkline\n'];
check('the real orphan (widgetEnergySparkline, PR #439) is reported',
  orphanWidgetFunctions(INCIDENT_FUNCTIONS, INCIDENT_WIDGETS), ['widgetEnergySparkline']);
check('…and a function a widget still invokes is NOT an orphan',
  orphanWidgetFunctions(['widgetEnergySparkline'],
    ['base44.functions.invoke(\'widgetEnergySparkline\', { days: 30 });']), []);
check('with a mix, only the unreferenced one is reported',
  orphanWidgetFunctions(['widgetA', 'widgetB', 'widgetC'],
    ["invoke('widgetA', {});", "invokeStream('widgetC', {});"]), ['widgetB']);

console.log('\n2. what a delete names — its own endpoint, never a shared one');
check('deleting a widget names the endpoint ITS OWN source invokes',
  widgetFunctionsToRemove("base44.functions.invoke('widgetEnergySparkline', {})", []),
  ['widgetEnergySparkline']);
check('…and refuses an endpoint another widget still invokes',
  widgetFunctionsToRemove("invoke('widgetShared', {})", ["invokeStream('widgetShared', {})"]), []);
check('…and names nothing when the widget has no backend endpoint',
  widgetFunctionsToRemove('export default function W() { return null; }', []), []);
check('…and never a shared, non-widget function',
  widgetFunctionsToRemove("base44.functions.invoke('backupDeckToDrive', {})", []), []);

console.log('\n3. the real tree: no endpoint without a widget, no call without an endpoint');
const widgetSources = readdirSync(join(REPO, WIDGETS_DIR))
  .filter((f) => f.endsWith('.jsx'))
  .map((f) => read(join(WIDGETS_DIR, f)));
const functionNames = readdirSync(join(REPO, FUNCTIONS_DIR))
  .filter((f) => /^widget[A-Z][A-Za-z0-9]*\.js$/.test(f))
  .map((f) => f.replace(/\.js$/, ''));
// Sanity: the widgets directory was really read, so an empty result above cannot
// be an empty directory read as a clean tree.
check('the widgets directory was actually read', widgetSources.length >= 15, true);
check('no backend endpoint is left without a widget invoking it',
  orphanWidgetFunctions(functionNames, widgetSources), []);
// The inverse, which keeps the tree honest in the other direction: a widget that
// invokes an endpoint the build never created is a dangling call.
const invokedByWidgets = new Set();
for (const src of widgetSources) for (const n of widgetBackendReferences(src)) invokedByWidgets.add(n);
check('no widget invokes an endpoint that does not exist',
  [...invokedByWidgets].filter((n) => !functionNames.includes(n)), []);

console.log('\n4. the delete path actually removes it (a rule nothing calls is H17)');
const del = codeOnly(read('server/src/functions/deleteDeckWidget.js'));
check('deleteDeckWidget imports the rule',
  /import\s*\{\s*widgetFunctionsToRemove\s*\}\s*from\s*'\.\.\/lib\/widgetBackendFunctions\.js'/.test(del), true);
check('…and calls it with the deleted widget\'s source and its siblings\' sources',
  /widgetFunctionsToRemove\(\s*widgetFile\.content,\s*siblingWidgets\.filter\(\(f\) => f\.id !== widgetFile\.id\)\.map\(\(f\) => f\.content\),?\s*\)/.test(del), true);
check('…and deletes those rows in the same transaction as the .jsx',
  /prisma\.projectFile\.deleteMany\(\{ where: \{ id: \{ in: backendFiles\.map\(\(f\) => f\.id\) \} \} \}\)/.test(del), true);
check('…and admits their paths to the scoped push, or the H9 scope would hide the deletion',
  /\.\.\.backendFiles\.map\(\(f\) => new RegExp\(`\^\$\{escapeRegex\(f\.path\)\}\$`\)\)/.test(del), true);
// The subject still exists: the contract still PERMITS the endpoint, and the
// policy still ALLOWS it, or this guard is guarding nothing.
const build = codeOnly(read('server/src/functions/buildDeckWidget.js'));
check('the build contract still permits a widget backend endpoint',
  /server\/src\/functions\/widget<PascalCase>\.js/.test(build), true);
const policy = codeOnly(read('server/src/lib/enginePolicy.js'));
check('the widget-build policy still allows exactly that path',
  /\^server\\\/src\\\/functions\\\/widget\[A-Z\]/.test(policy), true);

console.log('\n5. the rule is import-free, so this runs in the no-install CI job');
const rule = read('server/src/lib/widgetBackendFunctions.js');
check('no imports at all in the rule module', /^\s*import\s/m.test(rule), false);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ a deleted widget can still leave its backend endpoint routed and live\n');
  process.exit(1);
}
console.log('every widget endpoint belongs to a widget, and a widget deletion takes it\n');
