// Runtime verification that the "make a website" on-ramp is honest and cannot drift.
//
// Dependency-free (it imports the same pure module the UI imports and reads the surfaces as text),
// so it runs in CI's no-install guards job. Run:  node scripts/verify-onramp.mjs
//
// WHY THIS EXISTS
//
// Rob, 2026-09-28, two asks:
//   * "make that web app compile option the first one in the list and let people know somehow that
//     option is also for making your own website";
//   * the "set up my website" button "needs to stress its for wordpress integration and to get the
//     plugin".
//
// Both are copy-and-order changes, and both were about to be made on surfaces that had ALREADY
// drifted: the compile-target list was hardcoded in three dialogs, two of which omitted
// `linux-distro`, and the same target was worded differently in each. A reorder that lands on the
// create dialog and misses the switcher and the import dialog is the exact failure this catches —
// and it is the same shape as the calendar-row fix of the same day ("the floor is set once, so the
// next row cannot reintroduce it").
import { readFileSync } from 'node:fs';
import { COMPILE_TARGETS, targetOptions } from '../src/lib/compileTargets.js';
import { listCompileTargets } from '../server/src/lib/compile-targets/index.js';
import { checklistRows, isOptionalRow, remainingCount } from '../src/lib/onrampChecklist.js';
import { APP_KINDS, APP_KIND_SCHEMA, needsFor, normalizeAppKind } from '../server/src/lib/appKind.js';

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

const root = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(root + p, 'utf8');

console.log('\n1. web-app leads every list, and is worded for a website, not just an app');
check('the first compile target is web-app', COMPILE_TARGETS[0].value, 'web-app');
for (const style of ['create', 'import', 'bar']) {
  // `bar` shares a toolbar row, so it says "web app / site" — the word changes, the meaning must not.
  // A regression to plain "Web app" has neither word and still fails.
  check(`the "${style}" label for web-app names a website`, /website|site\b/i.test(COMPILE_TARGETS[0][style] || ''), true);
}

console.log('\n2. the one list is complete and unambiguous');
const values = COMPILE_TARGETS.map((t) => t.value);
check('target values are unique', values.length, new Set(values).size);
for (const style of ['create', 'import', 'bar']) {
  const missing = COMPILE_TARGETS.filter((t) => !t[style]).map((t) => t.value);
  check(`every target has a "${style}" label`, missing.join(','), '');
}

console.log('\n2b. the picker offers every target the server can actually build');
// ⚠️ THIS IS HOW THE AUDIO PLUGIN ROUTE SHIPPED INVISIBLE (2026-10-04). There are TWO lists — the server
// registry that knows how to build each target, and this picker that lets a user choose one — and nothing
// compared them. `audio-plugin` was in the registry, absent here, and therefore unchoosable: zero of the
// 17 projects in production had ever used it, against a target with a 89-check guard suite, a green
// `mutate-guards` run and a proven build on a runner. **A target nobody can pick is a target that does not
// exist**, and this is one line because both lists are data — the same shape as the SEO guard that pins the
// published target list to the compile-targets directory, which is why THAT drift could not happen.
const serverTargets = listCompileTargets();
check('no server target is missing from the picker', serverTargets.filter((id) => !values.includes(id)).join(','), '');
// `source` is deliberate: "Source code only" is a choice about what you receive, not a compiler that runs.
const PSEUDO = ['source'];
check('…and the picker offers nothing the server cannot build',
  values.filter((v) => !PSEUDO.includes(v) && !serverTargets.includes(v)).join(','), '');

console.log('\n2c. a route bound to one machine says so in the words a user reads');
// An id is not what a user sees — the label is. Every route whose id names a platform must say that
// platform in the label, because `VST3` (unlike `.dmg` or `.exe`) exists on more than one machine, so a
// label naming only formats reads as "builds for whatever you are on". The audio plugin route shipped
// exactly like that: `Audio Plugin (VST3 · AU · CLAP)`, on a target that can only emit macOS bundles.
const OS_WORDS = { macos: /mac/i, windows: /windows/i, linux: /linux/i, ios: /ios/i, android: /android/i, rpi: /raspberry|rpi/i };
const OS_ROUTES = values
  .map((v) => [v, Object.keys(OS_WORDS).find((w) => v.includes(w))])
  .filter(([, w]) => w);
check('there are OS-bound routes to check at all', OS_ROUTES.length >= 5, true);
check('…and each one\'s label names that machine', OS_ROUTES.filter(([v, w]) => {
  const t = COMPILE_TARGETS.find((x) => x.value === v);
  return !OS_WORDS[w].test(`${t.create} ${t.import} ${t.bar}`);
}).join(','), '');

console.log('\n3. every surface renders from that one list, in that one order');
const SURFACES = [
  ['src/components/matrix/NewProjectDialog.jsx', 'create'],
  ['src/components/matrix/ProjectBar.jsx', 'bar'],
  ['src/components/matrix/ImportGithubDialog.jsx', 'import'],
];
// Any of these literals in a surface means it went back to its own copy of the list. Built from `values`
// rather than written out: the hardcoded copy of this list was itself a drift site, and it had already
// missed a target by the time anyone looked.
const HARDCODED = new RegExp(`\\{\\s*value:\\s*'(${values.join('|')})'`, 'g');
for (const [file, style] of SURFACES) {
  const src = read(file);
  check(`${file} renders targetOptions('${style}')`, src.includes(`targetOptions('${style}')`), true);
  check(`${file} has no hardcoded target options`, [...src.matchAll(HARDCODED)].map((m) => m[1]).join(','), '');
  check(`${file} offers every target`, targetOptions(style).map((o) => o.value).join(','), values.join(','));
}

console.log('\n4. the create dialog says what a web app is actually for');
const createDialog = read(SURFACES[0][0]);
check('the helper line is gated on the web-app selection', createDialog.includes("target === 'web-app'"), true);
check('that helper line says it is how you make a website', /website/i.test(createDialog), true);

console.log('\n5. the website entry points name WordPress and the plugin');
const landing = read('src/pages/Landing.jsx');
check('the main-page button says WordPress', /SET UP MY WORDPRESS SITE/.test(landing), true);
check('the old generic label is gone', /SET UP MY WEBSITE\b/.test(landing), false);
check('the main page says the plugin has to be installed', /plugin/i.test(landing), true);

const workspace = read('src/pages/Workspace.jsx');
check('the empty-workspace button says WordPress', /SET UP MY WORDPRESS SITE/.test(workspace), true);
check('the empty-workspace copy says the plugin has to be installed', /plugin/i.test(workspace), true);

console.log('\n6. the second on-ramp exists, beside WordPress, for a site that does not exist yet');
// Rob, 2026-09-28: "we need another path there for people that just want to build a website or hosted
// full stack web app". The two paths must stay distinguishable: one operates a site you already run,
// the other builds one. A single button that does both is what he asked to stop.
check('the main page offers a build path', /BUILD A WEBSITE OR APP/.test(landing), true);
check('the build button returns to /begin after signing in', /returnTo=%2Fbegin/.test(landing), true);
check('the WordPress path still returns to /start', /returnTo=%2Fstart/.test(landing), true);

const app = read('src/App.jsx');
check('/begin is routed', /<Route path="\/begin" element=\{<Begin \/>\}/.test(app), true);
check('/begin is code-split like /start', /const Begin = lazy\(\(\) => import\('@\/pages\/Begin'\)\)/.test(app), true);

const begin = read('src/pages/Begin.jsx');
// It must reuse the construct the WordPress path opens rather than inventing a second kind of
// project — two would race, and ensureWebsiteConstruct exists precisely to decide that once.
check('the build path reuses the idempotent construct', begin.includes("invoke('ensureWebsiteConstruct'"), true);
check('the build path reuses the connections editor', begin.includes('ConnectionsDialog'), true);
check('the build path reads the real GitHub state', begin.includes('useGithubConnection'), true);
// The connection rows are built from the app's needs, so the state read is per-id rather than a
// hardcoded netlify field — which is what lets a database row appear when the app needs one.
check('the build path reads the real connection state', /connections\?\.\[id\]/.test(begin), true);
// The one thing nobody can automate is minting the token, so the page must send them to the
// provider's own page for that single action rather than implying it can be done for them.
check('the build path deep-links the one manual action',
  begin.includes('https://app.netlify.com/user/applications#personal-access-tokens'), true);
// The ethos, stated where the user decides: their account, their token, no custody.
check('the build path says the connection is the user\'s own', /your own \$\{p\.label\} account/.test(begin), true);
check('the build path says the credential is encrypted at rest', /encrypted at rest/i.test(begin), true);

console.log('\n7. the construct checklist follows the path the construct is actually on');
// Behavioural, not a regex: the rule itself is pure (lib/onrampChecklist.js) and this is the
// function the component calls. Before 2026-09-28 both paths got the WordPress rows, so someone who
// had just pressed "build a website" was told to install a WordPress plugin.
check('a WordPress construct gets the WordPress rows',
  checklistRows({ loadingSite: false, siteConnected: true }).join(','), 'github,site,copy,change');
check('a build construct gets the build rows, not the WordPress ones',
  checklistRows({ loadingSite: false, siteConnected: false }).join(','), 'github,hosting,wordpress,change');
// While the site check is in flight we do not know the path, and guessing shows a WordPress operator
// the build rows for a moment — the same confusion, just faster.
check('no path is assumed while the site check is in flight',
  checklistRows({ loadingSite: true, siteConnected: false }).join(','), 'github,change');
check('the WordPress row is the optional one', isOptionalRow('wordpress'), true);
check('nothing else is optional',
  ['github', 'hosting', 'site', 'copy', 'change'].filter(isOptionalRow).join(','), '');
// The count is what retires the checklist, so an optional row must not hold it open...
check('an optional row does not count towards "to go"',
  remainingCount(['github', 'hosting', 'wordpress', 'change'], { github: true, hosting: true }), 1);
// ...and a required one must.
check('a required row does count',
  remainingCount(['github', 'hosting', 'wordpress', 'change'], { github: true }), 2);

const checklist = read('src/components/matrix/FirstRunChecklist.jsx');
check('the checklist uses the shared decision rather than its own',
  checklist.includes('checklistRows('), true);
check('the checklist reads the real hosting state', /netlify\?\.token/.test(checklist), true);
check('the checklist keeps the WordPress path findable from the build path',
  checklist.includes('wordpress:') && /other path/.test(checklist), true);

console.log('\n8. what the operator asked for decides what they are asked to connect');
// The kind is the model's answer; the CONNECTION LIST is not. A wrong kind is one visible sentence the
// operator can overrule, while a wrong service list is an invisible hole — so this half is derived, and
// derived here is the half worth testing.
check('a static site needs build + host, and no database',
  needsFor('static').join(','), 'github,netlify');
check('a full-stack app needs a database as well',
  needsFor('fullstack').join(','), 'github,netlify,supabase');
check('an unusable answer degrades to the SMALLER list, not to nothing',
  normalizeAppKind({ kind: 'wat' }).needs.join(','), 'github,netlify');
check('an unusable answer is marked as a fallback rather than presented as a decision',
  normalizeAppKind({ kind: 'wat' }).fellBack, true);
check('a usable answer is not marked as a fallback',
  normalizeAppKind({ kind: 'fullstack', reason: 'it stores bookings' }).fellBack, false);
check('the reason is bounded, because it is rendered on a phone',
  normalizeAppKind({ kind: 'static', reason: 'x'.repeat(500) }).reason.length, 240);
check('only the two kinds are answers',
  APP_KIND_SCHEMA.properties.kind.enum.join(','), APP_KINDS.join(','));

const appKindFn = read('server/src/functions/classifyAppKind.js');
check('the decision names the classify role', /role:\s*'classify'/.test(appKindFn), true);
check('the description is bounded before it reaches a model', /MAX_DESCRIPTION = 2000/.test(appKindFn), true);
check('the verdict is normalized, never trusted as-is', appKindFn.includes('normalizeAppKind(result)'), true);

check('the on-ramp asks what the app should do', /classifyAppKind/.test(begin), true);
check('the on-ramp lets the operator overrule the guess',
  /It's just a website/.test(begin) && /It needs a backend/.test(begin), true);
check('the extra connection deep-links come from the shared registry',
  begin.includes("from '@/components/matrix/ConnectionsSection'"), true);

console.log('\n9. the last mile is named, in the words the controls actually carry');
// The whole path ends in two presses — COMPILE, then TAKE IT LIVE — and nothing else on
// either surface ever said so. A first-time user cannot guess it. Both the on-ramp and the
// construct checklist must say it, and must use the REAL labels: a guide that names a
// control that does not exist is worse than no guide, so the labels are read back off the
// components that render them.
check('the on-ramp names both publish controls',
  /COMPILE/.test(begin) && /TAKE IT LIVE/.test(begin), true);
check('the construct checklist names both too',
  /COMPILE/.test(checklist) && /TAKE IT LIVE/.test(checklist), true);
check('…and TAKE IT LIVE is the real label on the compile panel',
  /'TAKE IT LIVE'/.test(read('src/components/matrix/CompilePanel.jsx')), true);
check('…and COMPILE is the real label on the project bar',
  /COMPILE/.test(read('src/components/matrix/ProjectBar.jsx')), true);

console.log('\n10. the sentence typed on the on-ramp is not thrown away');
// It was: /begin asked "what should it do?", used the answer to choose which connections were
// needed, and then dropped it — so the operator landed in an empty chat and had to type the
// same sentence a second time. It is now handed to the composer as ADVICE, never auto-sent.
check('the on-ramp hands the description over',
  /state: \{ seedPrompt: description\.trim\(\) \}/.test(begin), true);
const workspaceSrc = read('src/pages/Workspace.jsx');
check('the construct reads it from the route', /useLocation\(\)\.state\?\.seedPrompt/.test(workspaceSrc), true);
check('…and passes it to the composer', /seed=\{seedPrompt\}/.test(workspaceSrc), true);
const chatPanel = read('src/components/matrix/ChatPanel.jsx');
check('the composer accepts a seed', /onSetWebAccess, seed \}\)/.test(chatPanel), true);
check('…fills only an empty box, so it cannot overwrite typing', /if \(!box \|\| box\.value\) return;/.test(chatPanel), true);
check('…and sends nothing on the operator\'s behalf', /onSend\(seed/.test(chatPanel), false);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) { console.log(`${failures} FAILED\n`); process.exit(1); }
console.log('all good\n');
