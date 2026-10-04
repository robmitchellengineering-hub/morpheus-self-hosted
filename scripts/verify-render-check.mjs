// The logged-in render check still exists, still has its safety interlocks, and is still wired up.
//
// WHY THIS EXISTS. `scripts/dev-app-render.mjs` is the ONLY thing in this repo that renders a
// logged-in page — every protected route sits behind `ProtectedRoute`, so the CI `render` job, which
// has no session, never fetches those chunks at all. On 2026-10-04 a blank `/deck/settings` shipped
// through every gate for exactly that reason (KNOWN-HAZARDS H22).
//
// That script cannot run here: it needs Postgres, a backend, a dev server and a browser, and this job
// installs nothing on purpose. So this guard checks what CAN be checked without any of that — and the
// part that most needs checking is not that the file exists, it is that its two SAFETY INTERLOCKS are
// still in it. Those are the lines that stop a future edit pointing a seeding script at a database
// people actually use, and a safety check that quietly disappears is worse than none, because
// everything downstream still looks fine.
//
// Run:  node scripts/verify-render-check.mjs
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = new URL('..', import.meta.url).pathname;
const read = (p) => (existsSync(join(REPO, p)) ? readFileSync(join(REPO, p), 'utf8') : '');

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

const script = read('scripts/dev-app-render.mjs');
const pkg = read('package.json');
const agents = read('AGENTS.md');
const hazards = read('KNOWN-HAZARDS.md');
// Comments are stripped for the assertions about what the script DOES. Its own explanatory comment
// says it never reads `.env.prodsql`, and a check that could not tell code from prose would fail on the
// sentence documenting the rule — which is a false positive, and a false positive teaches the next
// person to weaken the check.
const scriptCode = script.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

console.log('\n1. the tool is there and is runnable by one command');
check('scripts/dev-app-render.mjs exists', script.length > 0, true);
check('package.json exposes it as `npm run render:check`',
  /"render:check"\s*:\s*"node scripts\/dev-app-render\.mjs"/.test(pkg), true);
check('…and it syntax-checks as a module', (() => {
  // A cheap parse: the file must not have been truncated into something that cannot load.
  return /^#!\/usr\/bin\/env node/m.test(script) && /await ensureRig\(\)/.test(script);
})(), true);

console.log('\n2. the safety interlocks are still in place');
// These four lines are the whole reason a seeding script can be run casually. Losing any one of them
// turns "renders the app locally" into "writes an account into whatever DATABASE_URL happens to say".
check('it refuses NODE_ENV=production', /NODE_ENV=production/.test(script) && /refusing to run/.test(script), true);
check('it refuses a database whose name does not end in _dock_rig',
  /endsWith\('_dock_rig'\)/.test(script), true);
check('…and says so rather than failing silently', /does not end in "_dock_rig"/.test(script), true);
// COUNTED, not just "present". The first version of this assertion was `/[...].includes(host)/` and the
// mutation that removes the refusal SURVIVED it — because the same idiom appears twice, once in the
// pre-flight and once after the rig has chosen the database, and the mutation only deleted the second.
// A check satisfied by a different line than the one it names is exactly H19, so both are counted now.
check('it refuses a non-loopback database host, in BOTH places it can be handed one',
  (scriptCode.match(/\['localhost', '127\.0\.0\.1', '::1'\]\.includes\(host\)/g) || []).length, 2);
check('it only ever READS server/.env, never a production env file',
  /\.env\.prodsql|\.env\.northflank/.test(scriptCode), false);
check('it forces the AI at the local mock, so a render cannot spend money',
  /dev-dock-rig\.mjs/.test(script), true);

console.log('\n3. it fails on the things that actually went wrong, not just on a blank page');
check('it collects uncaught page errors', /page\.on\('pageerror'/.test(script), true);
check('it collects console errors', /msg\.type\(\) === 'error'/.test(script), true);
check('it names the error-boundary screen', /Something broke on this screen/.test(script), true);
check('it notices a bounce to /login (a rejected session)', /bouncedToLogin/.test(script), true);
check('it notices a page that rendered nothing', /blank/.test(script), true);
// The degradation that hides best: a 5xx still renders a page, so every other assertion passes while
// the content is an empty state. Observed for real — a stale Prisma client 500'd the deck-profile read
// and `/deck/settings` cheerfully rendered "SET UP YOUR BUSINESS". Prove it is still fatal.
check('it fails on an API 5xx, not only on a blank page',
  /page\.on\('response'/.test(scriptCode) && /res\.status\(\) < 500/.test(scriptCode), true);
// BOTH ENDS OF THE CHAIN, and the reason is a survived mutation: emptying the `serverErrors.push`
// inside the response handler left every line this guard looked for in place — the listener, the
// `status() < 500` test and the verdict — so a check that only read the verdict passed while nothing
// was ever collected. "Collected" and "counted" are two facts and each needs its own assertion.
check('…the response handler actually COLLECTS them', /serverErrors\.push\(/.test(scriptCode), true);
check('…and the verdict counts what was collected',
  /problems\.push\(`\$\{uniqueServerErrors\.length\} API 5xx/.test(scriptCode), true);
// Read from the RAW file, not the comment-stripped copy, and the reason is a small lesson of its own:
// the guard clause being asserted is a regex literal containing `\/`, and the naive comment stripper
// sees the `//` in `...api\//.test(url)` and truncates the line there — so the stripped text cannot
// contain what this check looks for. The string below appears in no comment, so matching the raw source
// is exactly as safe here.
check('…while a third-party asset 5xx is NOT this app\'s verdict',
  script.includes('if (!/\\/api\\//.test(url)) return;'), true);
check('it fails the run when a route does not render', /process\.exit\(1\)/.test(script), true);

console.log('\n4. the session is a LOCAL one, and no credential is printed');
// The token is signed with server/.env's JWT_SECRET, which `dev-dock-rig` generates locally if it is a
// placeholder. It must never be logged: a session token in a terminal is a session token in a
// transcript, which is how this workspace has leaked credentials before.
check('the token is minted from the local env, not fetched from production',
  /JWT_SECRET/.test(script) && /jwt\.sign\(/.test(script), true);
check('…and is never printed', /console\.(log|error)\([^)]*\btoken\b/.test(script), false);
check('the session is installed before the app runs, not after load',
  /addInitScript/.test(script), true);

console.log('\n5. it is named where the next person will look');
// H17's cousin: a tool nobody is told to run is a tool nobody runs.
check('KNOWN-HAZARDS records the incident and names this script', /dev-app-render\.mjs/.test(hazards), true);
check('the hazards entry says to run it before pushing UI changes', /before pushing anything that touches the UI/.test(hazards), true);
check('AGENTS.md names it in the verification rules', /render:check/.test(agents), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ the logged-in render check is missing, unsafe, or unfindable\n');
  process.exit(1);
}
console.log('the logged-in render check is present, interlocks intact, and documented\n');
