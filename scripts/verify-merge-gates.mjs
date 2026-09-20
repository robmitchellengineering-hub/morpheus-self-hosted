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
// Run:  node scripts/verify-merge-gates.mjs
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SELF_DEV_REQUIRED_CHECKS, requiredGateVerdict, requiredGateMessage } from '../server/src/lib/engine/requiredChecks.js';

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
const mergeAt = merge.indexOf('const { merged, mergeCommitSha } = await mergePullRequest');
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

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) {
  console.log('\nA merge that nothing verified is worse than a merge that waited.\n');
  process.exit(1);
}
console.log('all good\n');
