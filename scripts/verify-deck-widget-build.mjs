// Does a widget build survive the deploy it triggers?
//
// WHY THIS EXISTS. A Deck widget build runs for ~15 minutes inside the server process, then merges a
// PR — which starts a production deploy that REPLACES THAT PROCESS. Anything the build was going to
// do after the merge may never run, and there is no exception to catch: the request is simply gone.
//
// Measured in production, 2026-09-17 builds read 2026-09-28: two rows sat at 'deploying' and
// 'verifying' for eleven days. Their widget code had merged and their registry entries were live, but
// the step creating the account's DeckWidgetInstance row was BELOW the post-merge wait, so it never
// ran — the widget was unreachable, and Settings polls the newest row while its status is not
// done/failed, so the progress bar stayed frozen on a build that finished a week earlier.
//
// TWO INVARIANTS, and this guard exists for both:
//   1. ORDERING — the durable work (install the widget, reach a terminal status) happens BEFORE the
//      post-deploy wait in buildDeckWidget.js, and the terminal status happens before the wait in
//      deleteDeckWidget.js. This is the part a well-meaning refactor would "tidy" back under the
//      wait, which is why it is asserted structurally rather than left to a comment.
//   2. NO PERMANENT HANG — a non-terminal row that has stopped reporting is resolved, so a bar can
//      never sit frozen forever for any other reason (a crash, a container restart).
//
// Run:  node scripts/verify-deck-widget-build.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TERMINAL_BUILD_STATUSES, isTerminalBuildStatus, isStaleBuild, staleBuildMessage, STALE_BUILD_MS,
} from '../server/src/lib/deckWidgetBuildState.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(REPO, p), 'utf8');

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}
/** Position of a pattern, for the ordering assertions. -1 means "not there at all". */
const at = (src, re) => src.search(re);
/**
 * The text of the best-effort block: from the post-deploy sleep to the `} catch` that closes it.
 * Scoped deliberately — the function's OUTER crash handler legitimately writes `status: 'failed'`
 * further down, and asserting over the whole tail would fail on correct code.
 */
function bestEffortBlock(src) {
  const from = at(src, /await sleep\(75000\)/);
  if (from < 0) return '';
  const rest = src.slice(from);
  const end = rest.search(/\n\s*\} catch/);
  return end < 0 ? rest : rest.slice(0, end);
}

console.log('\n1. terminal and stale are different questions');
check('the terminal set is exactly done/failed', TERMINAL_BUILD_STATUSES.join(','), 'done,failed');
check('done is terminal', isTerminalBuildStatus('done'), true);
check('failed is terminal', isTerminalBuildStatus('failed'), true);
check('a mid-pipeline status is not terminal',
  ['planning', 'building', 'pushing', 'merging', 'deploying', 'verifying'].some(isTerminalBuildStatus), false);
check('…and neither is a status we have never seen', isTerminalBuildStatus('brand_new_stage'), false);
check('…nor an absent one', [isTerminalBuildStatus(null), isTerminalBuildStatus(''), isTerminalBuildStatus(undefined)].join(','), 'false,false,false');

console.log('\n2. staleness is measured from the last REPORT, not from creation');
const NOW = Date.parse('2026-09-28T12:00:00Z');
const fresh = { status: 'building', updated_date: new Date(NOW - 60_000), created_date: new Date(NOW - 900_000) };
check('a build reporting a minute ago is alive', isStaleBuild(fresh, NOW), false);
// The false positive that would get this switched off: a build created long ago but still reporting.
const slowButAlive = { status: 'building', updated_date: new Date(NOW - 20 * 60_000), created_date: new Date(NOW - 90 * 60_000) };
check('a long build that is still reporting is ALIVE', isStaleBuild(slowButAlive, NOW), false);
check('…so a 90-minute-old build is judged on its last report, not its age', isStaleBuild(slowButAlive, NOW), false);
const dead = { status: 'deploying', updated_date: new Date(NOW - STALE_BUILD_MS - 60_000), created_date: new Date(NOW - 3_600_000) };
check('a row quiet for longer than the window is stale', isStaleBuild(dead, NOW), true);
check('right at the boundary it is not yet stale',
  isStaleBuild({ status: 'verifying', updated_date: new Date(NOW - STALE_BUILD_MS) }, NOW), false);
check('a terminal row is never stale, however old',
  isStaleBuild({ status: 'done', updated_date: new Date(NOW - 40 * 86_400_000) }, NOW), false);
check('an unreadable timestamp does not invent staleness',
  [isStaleBuild({ status: 'building' }, NOW), isStaleBuild({ status: 'building', updated_date: 'not-a-date' }, NOW)].join(','), 'false,false');
check('no row at all is not stale', isStaleBuild(null, NOW), false);
check('the window is 30 minutes — 2x a ~15-minute build', STALE_BUILD_MS, 30 * 60 * 1000);

console.log('\n3. the message on the Settings card is product copy, not an incident note');
const msg = staleBuildMessage(dead, NOW);
check('it says how far the build got', /Stopped while deploying/.test(msg), true);
check('…that waiting longer will not help', /not running any more/.test(msg), true);
check('…that whatever it already finished is live', /already finished is live/.test(msg), true);
check('…and what to do about it', /ask for it again/i.test(msg), true);
// The first version of this string explained that "a widget build runs inside the server process,
// and the deploy it triggers replaces that process". All true, and exactly what a user must not be
// shown — Rob read it back off his own Settings card. `WidgetBuildProgress` prints this message
// under the bar, so the card is the register that matters here, not the code comment.
check('…and never leaks operator language onto the card',
  /process|replaces|post-deploy|registry|by hand|#\d+/i.test(msg), false);
check('a status that is not a gerund is quoted, not bent into a wrong sentence',
  /Stopped at "weird_stage"/.test(staleBuildMessage({ status: 'weird_stage' }, NOW)), true);
check('no status at all still reads as a sentence',
  /Stopped part-way/.test(staleBuildMessage({}, NOW)), true);

console.log('\n4. the durable work happens BEFORE the wait that the deploy can cut off');
const build = read('server/src/functions/buildDeckWidget.js');
const installAt = at(build, /await installWidgetInstance\(requestingUser\.id, widgetKey\)/);
const sleepAt = at(build, /await sleep\(75000\)/);
const finishAt = at(build, /const finished = await finish\(\{/);
check('the widget install is there at all', installAt > 0, true);
check('the post-deploy wait is still there (best-effort, not deleted)', sleepAt > 0, true);
check('the widget is INSTALLED before the wait', installAt < sleepAt, true);
check('the build reaches a terminal status before the wait', finishAt < sleepAt, true);
check('…and the terminal call is on the ok path, so a killed process leaves done',
  /const finished = await finish\(\{\s*\n\s*ok: true,/.test(build), true);
check('the only sleep after the install is inside a try (best-effort)', 
  /try \{\s*\n\s*await sleep\(75000\);/.test(build.slice(installAt)), true);
check('…and that block cannot change the status, only the message',
  /updateBuild\(build\.id, \{/.test(bestEffortBlock(build)) && !/status:/.test(bestEffortBlock(build)), true);
check('the install is idempotent (unique key, not a blind create)',
  /created_by_id_widget_key/.test(build) && /findUnique/.test(build), true);

const del = read('server/src/functions/deleteDeckWidget.js');
const delFinishAt = at(del, /const finished = await finish\(\{/);
const delSleepAt = at(del, /await sleep\(75000\)/);
check('deletion reaches a terminal status before its wait', delFinishAt > 0 && delFinishAt < delSleepAt, true);
check('…and its post-wait block only rewrites the message',
  /updateJob\(job\.id, \{/.test(bestEffortBlock(del)) && !/status:/.test(bestEffortBlock(del)), true);

console.log('\n5. a row that stops reporting can never hang the bar');
const entities = read('server/src/entities.js');
check('the poll path the UI uses reconciles widget builds',
  /if \(name === 'DeckWidgetBuild'\) await reconcileStaleWidgetBuilds\(user\.id\)/.test(entities), true);
const rec = read('server/src/lib/deckWidgetBuildReconcile.js');
check('the reconciler only looks at non-terminal rows',
  /status: \{ notIn: TERMINAL_BUILD_STATUSES \}/.test(rec), true);
check('…it shares the rule instead of re-deriving it', /isStaleBuild\(row, nowMs\)/.test(rec), true);
check('…and it resolves them to a terminal status with the message from the rule',
  /status: 'failed', message: staleBuildMessage\(row, nowMs\)/.test(rec), true);

console.log('\n6. the rule is import-free, so this runs in the no-install CI job');
const state = read('server/src/lib/deckWidgetBuildState.js');
check('no imports at all in the rule module', /^\s*import\s/m.test(state), false);

console.log('\n7. a FINISHED card cannot become permanent furniture in Settings');
// Rob, 2026-10-04: "we still have that failed widget in my settings". The dismissal only ever lived in
// localStorage, so it did not survive another device or a cleared cache, and with no dismissal a failed
// card stayed until the end of time. The card now expires on its own.
const {
  TERMINAL_BUILD_VISIBLE_MS, shouldShowWidgetBuildCard,
  TERMINAL_BUILD_STATUSES: TERMINAL_BUILD_CARD_STATUSES,
  isTerminalBuildStatus: isTerminalOnClient,
} = await import('../src/lib/deckWidgetBuildCard.js');

check('the card rule and the server rule agree on what "finished" means',
  TERMINAL_BUILD_STATUSES.join(','), TERMINAL_BUILD_CARD_STATUSES.join(','));
check('…and answer the question the same way for every status',
  ['done', 'failed', 'building', 'planning', 'weird', ''].map((s) => [isTerminalBuildStatus(s), isTerminalOnClient(s)].join('')).join('|'),
  'truetrue|truetrue|falsefalse|falsefalse|falsefalse|falsefalse');
check('a finished card is shown for a day', TERMINAL_BUILD_VISIBLE_MS, 24 * 60 * 60 * 1000);

const settled = (status, ageMs, extra = {}) => ({
  id: 'row-1', status, updated_date: new Date(NOW - ageMs), created_date: new Date(NOW - ageMs), ...extra,
});
check('no row means no card', shouldShowWidgetBuildCard(null, { nowMs: NOW }), false);
check('a running build is ALWAYS shown',
  shouldShowWidgetBuildCard(settled('building', 30 * 86_400_000), { nowMs: NOW }), true);
check('…even when its row is ancient, because progress is progress',
  shouldShowWidgetBuildCard({ id: 'r', status: 'verifying' }, { nowMs: NOW }), true);
check('a build that just finished is shown', shouldShowWidgetBuildCard(settled('failed', 60_000), { nowMs: NOW }), true);
check('…and is still shown a few hours later, so stepping away does not miss it',
  shouldShowWidgetBuildCard(settled('done', 6 * 3_600_000), { nowMs: NOW }), true);
check('…right at the boundary it is still shown',
  shouldShowWidgetBuildCard(settled('failed', TERMINAL_BUILD_VISIBLE_MS), { nowMs: NOW }), true);
check("yesterday's failed build is gone", shouldShowWidgetBuildCard(settled('failed', 25 * 3_600_000), { nowMs: NOW }), false);
check('…and an old success is gone too', shouldShowWidgetBuildCard(settled('done', 3 * 86_400_000), { nowMs: NOW }), false);
check('a dismissal hides a settled row', shouldShowWidgetBuildCard(settled('failed', 60_000), { nowMs: NOW, dismissedId: 'row-1' }), false);
// The dismissal must not be able to hide a build that is still running: the X only renders on a settled
// card, but a stored id from an earlier page must not swallow live progress if it ever did.
check('…but never hides one that is still running',
  shouldShowWidgetBuildCard({ id: 'row-1', status: 'building' }, { nowMs: NOW, dismissedId: 'row-1' }), true);
check('…and cannot hide a DIFFERENT, newer build',
  shouldShowWidgetBuildCard({ ...settled('failed', 60_000), id: 'row-2' }, { nowMs: NOW, dismissedId: 'row-1' }), true);
check('an unreadable age keeps the card rather than guessing',
  [shouldShowWidgetBuildCard({ id: 'r', status: 'failed' }, { nowMs: NOW }),
    shouldShowWidgetBuildCard({ id: 'r', status: 'failed', updated_date: 'not-a-date' }, { nowMs: NOW })].join(','),
  'true,true');
check('a created_date is enough when updated_date is missing',
  shouldShowWidgetBuildCard({ id: 'r', status: 'failed', created_date: new Date(NOW - 60_000) }, { nowMs: NOW }), true);

console.log('\n8. Settings renders that rule, and polling is not tied to the card being visible');
const ctx = read('src/contexts/CommandDeckContext.jsx');
check('the poll path asks the rule instead of deciding inline',
  /setWidgetBuild\(shouldShowWidgetBuildCard\(latest, \{ dismissedId \}\) \? latest : null\)/.test(ctx), true);
check('…the old settled-and-dismissed comparison is gone',
  /settled && latest\.id === dismissedId \? null : latest/.test(ctx), false);
check('…and polling still follows any build that has not finished',
  /if \(latest && !settled\) \{\s*\n\s*widgetBuildPollTimer\.current = window\.setTimeout\(pollWidgetBuild, 5000\);/.test(ctx), true);
const settings = read('src/pages/CommandDeck/DeckSettings.jsx');
check('the card renders from the same terminal test as the rule',
  /const isTerminal = isTerminalBuildStatus\(status\);/.test(settings), true);
check('the expiry lives in ONE place the browser can import',
  /^import \{ isTerminalBuildStatus, shouldShowWidgetBuildCard \} from '@\/lib\/deckWidgetBuildCard';$/m.test(ctx), true);

const card = read('src/lib/deckWidgetBuildCard.js');
check('the card rule is import-free too', /^\s*import\s/m.test(card), false);

// ⚠️ A CALL IS NOT WIRING — the same check the order rule gained, for the same outage. `#502` shipped
// `orderDeckWidgets is not defined` to production because a call was added without its import, and no
// gate resolves identifiers. Every consumer of this module is checked the same way: it must import
// each name it uses. Comments are stripped so a name mentioned in prose is not read as a usage.
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
function importedFrom(src, moduleName) {
  const re = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*['"][^'"]*${moduleName}['"]`, 'g');
  return [...src.matchAll(re)]
    .flatMap((m) => m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean));
}
const CARD_EXPORTS = ['TERMINAL_BUILD_STATUSES', 'TERMINAL_BUILD_VISIBLE_MS', 'isTerminalBuildStatus', 'shouldShowWidgetBuildCard'];
for (const [label, src] of [['CommandDeckContext.jsx', ctx], ['DeckSettings.jsx', settings]]) {
  const body = codeOnly(src);
  const imported = importedFrom(body, 'deckWidgetBuildCard');
  const used = CARD_EXPORTS.filter((n) => new RegExp(`\\b${n}\\b`).test(body));
  check(`${label} imports every name it uses from the card rule`,
    `${used.filter((n) => !imported.includes(n)).join(',')} | used ${used.length} imported ${imported.length}`,
    ` | used ${used.length} imported ${used.length}`);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ a widget build can still be cut off by its own deploy\n');
  process.exit(1);
}
console.log('a widget build survives the deploy it triggers\n');
