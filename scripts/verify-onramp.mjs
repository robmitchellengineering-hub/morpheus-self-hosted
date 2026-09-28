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

console.log('\n3. every surface renders from that one list, in that one order');
const SURFACES = [
  ['src/components/matrix/NewProjectDialog.jsx', 'create'],
  ['src/components/matrix/ProjectBar.jsx', 'bar'],
  ['src/components/matrix/ImportGithubDialog.jsx', 'import'],
];
// Any of these literals in a surface means it went back to its own copy of the list.
const HARDCODED = /\{\s*value:\s*'(source|windows-exe|mac-app|linux-binary|android-apk|ios-app|python-package|web-app|rpi-distro|linux-distro|arduino-firmware)'/g;
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
check('the build path reads the real Netlify state', /connections\?\.netlify\?\.token/.test(begin), true);
// The one thing nobody can automate is minting the token, so the page must send them to the
// provider's own page for that single action rather than implying it can be done for them.
check('the build path deep-links the one manual action',
  begin.includes('https://app.netlify.com/user/applications#personal-access-tokens'), true);
// The ethos, stated where the user decides: their account, their token, no custody.
check('the build path says the hosting is the user\'s own', /your own Netlify account/i.test(begin), true);
check('the build path says the credential is encrypted at rest', /encrypted at rest/i.test(begin), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) { console.log(`${failures} FAILED\n`); process.exit(1); }
console.log('all good\n');
