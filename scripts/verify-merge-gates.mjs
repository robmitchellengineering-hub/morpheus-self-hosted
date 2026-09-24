// Merge gates: the checks that must have RUN before a change counts as verified.
//
// WHY THIS EXISTS
//
// The merge engine used to merge whenever nothing had *failed*. GitHub does not
// create a PR's `pull_request` workflow run when it cannot compute the merge
// commit, and it never backfills it, so on 2026-09-20 PRs #258 and #259 carried a
// full set of green Netlify previews and no CI run at all. Every present check
// passed — including two reported `skipped` — the combined state read `passing`,
// and the "no checks yet" grace did not apply because checks existed, just not
// the ones that verify the code. A green deploy preview could have been the only
// gate before production.
//
// The verdict logic is pure and lives in server/src/lib/engine/requiredChecks.js,
// which is what lets this run in CI's no-install guards job (hazard H4). This
// file asserts the two things a unit test cannot: that the declared gate names
// still match the workflow's own job names, and that the engine and the self-dev
// adapter actually consult them.
//
// It also asserts that GitHub itself still enforces the same gates. Branch
// protection was set by hand on 2026-09-24 with a `gh api` call, so before this
// the requirement existed in two places that nothing compared: the constant in
// requiredChecks.js and a setting in GitHub's UI. The comparison is pure
// (server/src/lib/branchProtectionRules.js) precisely so it can be exercised
// here, with no network; scripts/check-branch-protection.mjs does the live read.
//
// Run:  node scripts/verify-merge-gates.mjs
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SELF_DEV_REQUIRED_CHECKS, requiredGateVerdict, requiredGateMessage } from '../server/src/lib/engine/requiredChecks.js';
import { protectionVerdict } from '../server/src/lib/branchProtectionRules.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(REPO, p), 'utf8');

let pass = 0;
let fail = 0;
const problems = [];

function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) {
    console.log(`          expected ${JSON.stringify(want)}\n          got      ${JSON.stringify(got)}`);
    problems.push(name);
  }
  ok ? pass++ : fail++;
}

// The `name:` of every job in a workflow, so a rename on one side of the
// requirement cannot silently disable it. Deliberately line-based: it must not
// need a YAML dependency, because this runs with nothing installed.
function jobNames(yaml) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start === -1) return null;
  const names = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line)) break;                 // the next top-level key ends the block
    const m = line.match(/^ {4}name:\s*(\S.*?)\s*$/);
    if (m) names.push(m[1].replace(/^["']|["']$/g, ''));
  }
  return names;
}

console.log('\n-- the parser itself, so a parity check cannot pass vacuously --');
const FIXTURE = ['name: CI', 'on:', '  pull_request:', 'jobs:', '  build:', '    name: lint + build', '  guards:', '    name: guards (no install)', '  other:', '    runs-on: ubuntu-latest', ''].join('\n');
check('the parser finds job names', jobNames(FIXTURE), ['lint + build', 'guards (no install)']);
check('…and stops at the next top-level key', jobNames(`${FIXTURE}permissions:\n  name: not a job\n`).length, 2);
check('a workflow with no jobs block is null, not an empty pass', jobNames('name: CI\non: push\n'), null);

console.log('\n-- the declared gates match the workflow that runs them --');
const ci = read('.github/workflows/ci.yml');
const jobs = jobNames(ci);
check('the workflow parsed', Array.isArray(jobs) && jobs.length > 0, true);
check('the required list is not empty', SELF_DEV_REQUIRED_CHECKS.length > 0, true);
check('no gate is listed twice', new Set(SELF_DEV_REQUIRED_CHECKS).size, SELF_DEV_REQUIRED_CHECKS.length);
// Subset, not equality: adding a CI job must not fail this guard, but renaming
// or deleting a job that is required here must.
check('every required gate is a real job in ci.yml', SELF_DEV_REQUIRED_CHECKS.filter((n) => !(jobs || []).includes(n)), []);
check('the gate the guards job runs is one of them', (jobs || []).some((n) => /guard/i.test(n)), true);

console.log('\n-- the incident shape cannot read as verified --');
const INCIDENT = [
  { name: 'Redirect rules - morpheus-self-hosted-app', status: 'completed', conclusion: 'success' },
  { name: 'netlify/morpheus-self-hosted-app/deploy-preview', status: 'completed', conclusion: 'success' },
  { name: 'Header rules - morpheus-self-hosted-app', status: 'completed', conclusion: 'skipped' },
];
const incident = requiredGateVerdict(INCIDENT, SELF_DEV_REQUIRED_CHECKS);
check('green previews with no CI run are refused', incident.ok, false);
check('…naming both gates that never ran', incident.missing, SELF_DEV_REQUIRED_CHECKS);
check('…and telling the operator the one thing that fixes it', /reopen it|Close the pull request/.test(requiredGateMessage(incident)), true);
check('a repo with no known gates is unaffected', requiredGateVerdict(INCIDENT, []).ok, true);

console.log('\n-- the engine consults them --');
const merge = read('server/src/lib/engine/merge.js');
check('the engine imports the verdict', /import \{ requiredGateVerdict, requiredGateMessage \} from '\.\/requiredChecks\.js';/.test(merge), true);
check('it requires the caller\u2019s list, defaulting to none', /requiredChecks = \[\]/.test(merge), true);
check('it passes the head commit\u2019s checks and the list to the verdict', /requiredGateVerdict\(checks\.checks, requiredChecks\)/.test(merge), true);
check('a failed verdict becomes a terminal result, not a merge', /merged: false, state: 'failed'/.test(merge) && /missingChecks: gate\.missing/.test(merge), true);
check('…carrying the operator-facing message', /message: requiredGateMessage\(gate\)/.test(merge), true);
check('…and the gate names, so a caller never has to parse prose', /requiredChecks: gate\.required/.test(merge), true);
// Ordering matters, so both markers must be FOUND first: a missing marker makes
// indexOf return -1, and -1 < anything would otherwise pass vacuously.
const conflictAt = merge.indexOf("state: 'conflict', prNumber, prUrl:");
const gateAt = merge.indexOf('const gate = requiredGateVerdict(checks.checks, requiredChecks);');
const forceAt = merge.indexOf('if (!force) {');
// The call itself, inside its try — the merge the gate above has to precede.
const mergeAt = merge.indexOf('mergeResult = await mergePullRequest(');
check('both branches were found to order', conflictAt > -1 && gateAt > -1 && forceAt > -1 && mergeAt > -1, true);
// A conflict is why GitHub never created the run, so it is answered first.
check('the conflict answer comes before the gate verdict', conflictAt < gateAt, true);
// `force` is an explicit operator override and still bypasses the requirement.
check('the requirement lives inside the !force branch', forceAt < gateAt, true);
check('…and before the merge it guards', gateAt < mergeAt, true);

console.log('\n-- and self-dev is the caller that declares them --');
const selfDev = read('server/src/lib/delivery/selfDev.js');
check('self-dev imports the declared gates', /import \{ SELF_DEV_REQUIRED_CHECKS \} from '\.\.\/engine\/requiredChecks\.js';/.test(selfDev), true);
check('self-dev passes them to its own repo\u2019s merge', /requiredChecks: SELF_DEV_REQUIRED_CHECKS/.test(selfDev), true);
// The WordPress adapter merges into a tenant repo whose CI we do not know, so it
// must NOT claim a gate list: that would block every PR on a repo with no CI.
const wp = read('server/src/lib/delivery/wordpress.js');
check('the WordPress adapter declares no gates it cannot know', /requiredChecks/.test(wp), false);

console.log('\n-- and GitHub is required to enforce them, not only merge.js --');
// The pure comparison behind scripts/check-branch-protection.mjs, exercised here
// because the live reading needs `gh` and a token while this must run with
// nothing installed. Every drift branch is asserted to FAIL, which is the only
// thing that makes the live check worth running.
const protection = (contexts, extra = {}) => ({
  required_status_checks: { strict: false, contexts },
  enforce_admins: { enabled: false },
  allow_force_pushes: { enabled: false },
  allow_deletions: { enabled: false },
  ...extra,
});

const agreed = protectionVerdict(protection(SELF_DEV_REQUIRED_CHECKS), SELF_DEV_REQUIRED_CHECKS);
check('agreement reports ok', agreed.ok, true);
check('…with every gate accounted for', agreed.missing.concat(agreed.extra), []);

const dropped = protectionVerdict(protection(['guards (no install)', 'lint + build']), SELF_DEV_REQUIRED_CHECKS);
check('a gate GitHub is not enforcing is caught', dropped.ok, false);
check('…and named', dropped.missing, ['render']);

const undeclared = protectionVerdict(protection([...SELF_DEV_REQUIRED_CHECKS, 'some other gate']), SELF_DEV_REQUIRED_CHECKS);
check('a gate enforced but not declared is caught', undeclared.ok, false);
check('…and named', undeclared.extra, ['some other gate']);

const gone = protectionVerdict(null, SELF_DEV_REQUIRED_CHECKS);
check('an unprotected branch is caught', gone.ok, false);
check('…as unprotected, not as an unexplained empty list', gone.unprotected, true);
check('…and every gate is reported missing', gone.missing, SELF_DEV_REQUIRED_CHECKS);

const forced = protectionVerdict(protection(SELF_DEV_REQUIRED_CHECKS, { allow_force_pushes: { enabled: true } }), SELF_DEV_REQUIRED_CHECKS);
check('allowing force-pushes on main is caught', forced.ok, false);

// The deliberate settings must NOT read as drift, or the check is noise and gets
// ignored — which is how a real drift slips through unnoticed.
const deliberate = protectionVerdict(
  protection(SELF_DEV_REQUIRED_CHECKS, {
    required_status_checks: { strict: true, contexts: SELF_DEV_REQUIRED_CHECKS },
    enforce_admins: { enabled: true },
  }),
  SELF_DEV_REQUIRED_CHECKS,
);
check('strict + admin enforcement still report ok', deliberate.ok, true);
check('…because they are reported, not judged', [deliberate.strict, deliberate.adminsBypass], [true, false]);

// GitHub returns contexts in whatever order it likes, and a string can carry
// whitespace. Neither is drift; the engine's own matcher trims for the same
// reason.
check('context order is not drift', protectionVerdict(protection([...SELF_DEV_REQUIRED_CHECKS].reverse()), SELF_DEV_REQUIRED_CHECKS).ok, true);
check('surrounding whitespace is not drift', protectionVerdict(protection(SELF_DEV_REQUIRED_CHECKS.map((n) => ` ${n} `)), SELF_DEV_REQUIRED_CHECKS).ok, true);

console.log('\n-- and the live reading uses the same declared gates --');
const live = read('scripts/check-branch-protection.mjs');
check('the live check imports the declared gates', /import \{ SELF_DEV_REQUIRED_CHECKS \} from '\.\.\/server\/src\/lib\/engine\/requiredChecks\.js';/.test(live), true);
// If it rebuilt the comparison locally, the two could drift and both would pass.
check('…and the shared comparison, not a reimplementation', /import \{ protectionVerdict, protectionMessage \} from '\.\.\/server\/src\/lib\/branchProtectionRules\.js';/.test(live), true);
// Deliberate: verify.mjs must keep working with no token and no network.
check('…and is NOT wired into verify.mjs', /check-branch-protection/.test(read('scripts/verify.mjs')), false);

console.log('\n-- and a decline by GitHub itself is a state, not a throw --');
// Branch protection moved part of the decision into GitHub. Before it, this call
// could not realistically throw, so an unwrapped await was fine; now "the base
// branch policy prohibits the merge" can come back, and an unhandled throw
// replaces the caller's `merge_failed` state with an exception.
check('the merge call is wrapped', /try \{\s*\n\s*mergeResult = await mergePullRequest\(/.test(merge), true);
check('…reading the API\u2019s own message', /err\?\.details\?\.message \|\| err\?\.message/.test(merge), true);
check('…distinguishing a policy decline from a transient one', /status === 405 && \/branch policy\|protected branch\//.test(merge), true);
// The point of the policy message is that the operator is told which setting to
// look at, so it must name the command that reads that setting.
check('…and pointing at the check that explains it', /node scripts\/check-branch-protection\.mjs/.test(merge), true);
// The generic sentence is what this replaced; if it survives, one of the two
// paths above is dead code.
check('the old "check the PR" catch-all is gone', /GitHub declined the merge — check the PR\./.test(merge), false);

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) {
  console.log('\nA merge that nothing verified is worse than a merge that waited.\n');
  process.exit(1);
}
console.log('all good\n');
