// The engine policy has to be enforced, not just declared.
//
// WHY THIS EXISTS
//
// `lib/enginePolicy.js` carried `allowForce: false` and `allowDirectToMain:
// false` on its scoped policies for a week while NOTHING read them:
// `pushSelfDevToGithub` honoured `body.force` regardless, so the two fields
// documented a safety property that did not exist. The file's own header even
// admitted it — "nothing enforces the whole of this yet" — which is exactly the
// kind of sentence that reads as a caveat and behaves as a trap, because a
// reader looking for the check finds a policy field that says the check is
// configured.
//
// Nothing catches that. A field that is declared and unread fails no test, breaks
// no build, and looks correct in review. So the rule is asserted here instead.
//
// Two halves, and both are needed:
//
//   1. the DECISION is pure (`evaluatePushPolicy`) and is exercised directly
//      against real policy objects — that is the behavioural half;
//   2. the WIRING is asserted against the source, because the failure mode is
//      "the rule exists but nothing calls it", which no unit test can see.
//
// The source assertions are the weaker half by nature, so they are written to
// check ORDER and PRESENCE-OF-USE where that is what matters (the policy check
// must precede the verify gate it guards) rather than merely that a string
// appears somewhere in the file.
//
// Run:  node scripts/verify-push-policy.mjs
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluatePushPolicy, ADMIN, PLUGIN_TENANT, WIDGET_BUILD, resolvePolicy } from '../server/src/lib/enginePolicy.js';

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

console.log('\n1. the policy decision is enforced (pure, exercised directly)')

// The admin policy is what makes self-dev usable: force is how a red verify gets
// overridden deliberately, and the direct path is the original behaviour.
check('admin: a plain push is allowed', evaluatePushPolicy(ADMIN), null);
check('admin: force is allowed', evaluatePushPolicy(ADMIN, { force: true }), null);
check('admin: directToMain is allowed', evaluatePushPolicy(ADMIN, { directToMain: true }), null);

// A scoped policy must refuse both. These are the two assertions that would have
// failed before this change, because there was nothing to call.
for (const [label, policy] of [['plugin_tenant', PLUGIN_TENANT], ['widget_build', WIDGET_BUILD]]) {
  check(`${label}: a plain push is allowed`, evaluatePushPolicy(policy), null);
  const forced = evaluatePushPolicy(policy, { force: true });
  check(`${label}: force is REFUSED`, forced?.reason, 'force-not-allowed');
  check(`${label}: the refusal explains itself`, /does not allow force/.test(forced?.message || ''), true);
  const direct = evaluatePushPolicy(policy, { directToMain: true });
  check(`${label}: directToMain is REFUSED`, direct?.reason, 'direct-to-main-not-allowed');
}

// An ad-hoc per-call policy (the widget-deletion shape) declares no allowForce at
// all. Absent must mean refused — a permissive default here would mean every
// future ad-hoc policy silently opts into force.
const adHoc = { id: 'widget_delete', allowPathPrefixes: [/^src\/pages\/CommandDeck\/widgets\//] };
check('an ad-hoc policy with no allowForce refuses force', evaluatePushPolicy(adHoc, { force: true })?.reason, 'force-not-allowed');
check('…and refuses directToMain', evaluatePushPolicy(adHoc, { directToMain: true })?.reason, 'direct-to-main-not-allowed');
check('an unknown policy id still throws', (() => { try { resolvePolicy('nope'); return 'no throw'; } catch (e) { return e.status; } })(), 400);

console.log('\n2. the wiring calls it, in the right order')

const push = read('server/src/functions/pushSelfDevToGithub.js');
check('pushSelfDevToGithub imports the rule', /import\s*\{[^}]*evaluatePushPolicy[^}]*\}\s*from\s*'\.\.\/lib\/enginePolicy\.js'/.test(push), true);

// The refusal has to be acted on, not merely computed.
check('the result is turned into a blocked response', /if \(policyRefusal\)\s*\{[^}]*blocked:\s*true/s.test(push), true);

// ORDER IS THE POINT: `force` is the verify gate's override, so a policy that
// forbids force must refuse it BEFORE verification is skipped. If the policy
// check moved after runVerifySelfDev, force would still bypass the gate for one
// turn and the check would be decoration.
const policyCheckAt = push.indexOf('evaluatePushPolicy(governingPolicy')
const verifyGateAt = push.indexOf('runVerifySelfDev(user)')
check('both the check and the gate are present', policyCheckAt > -1 && verifyGateAt > -1, true)
check('the policy check precedes the verify gate it guards', policyCheckAt > -1 && policyCheckAt < verifyGateAt, true)

// force must NOT reach the drift guard: overriding a failed verify says nothing
// about whether the workspace is stale, and H9 — the incident this guard exists
// for — happened on the direct path. The drift override is its own deliberate
// flag.
const driftCall = push.slice(push.indexOf('evaluateDrift({'), push.indexOf('})', push.indexOf('evaluateDrift({')));
check('the drift guard is passed acknowledgeDrift', /acknowledgeDrift\s*:/.test(driftCall), true);
// Assert the IDENTIFIERS are absent, not a `key:` shape: `evaluateDrift({ …,
// force })` is shorthand for `force: force` and slipped past a colon-anchored
// regex when this check was first written. The mutation test is what caught it —
// an assertion that only recognises one spelling of the bug is half a check.
check('the drift guard references neither force nor directToMain', /\b(force|directToMain)\b/.test(driftCall), false);

// The scope a push is held to and the scope that exempts it must be one object.
check('the governing policy is resolved once and reused', (push.match(/resolvePolicy\(scopePolicy[^)]*\)/g) || []).length, 1);

console.log('\n3. the self-dev workspace is resolved by owner, deterministically')

const widget = read('server/src/functions/buildDeckWidget.js');
check('the resolver scopes to an admin owner', /project_type:\s*'self_dev',\s*owner:\s*\{\s*role:\s*'admin'\s*\}/.test(widget), true);
check('and orders deterministically', /orderBy:\s*\{\s*created_date:\s*'asc'\s*\}/.test(widget), true);

// The regression shape, asserted across the whole server tree: EVERY lookup of a
// self_dev project must carry the owning account. Any file that adds an unscoped
// one re-opens the hole this change closed, whatever it intends.
const files = [
  'server/src/entities.js',
  'server/src/functions/buildDeckWidget.js',
  'server/src/functions/deleteDeckWidget.js',
  'server/src/functions/pushSelfDevToGithub.js',
  'server/src/functions/importSelfDevRepo.js',
  'server/src/functions/verifySelfDev.js',
  'server/src/functions/revertSelfDevPush.js',
  'server/src/functions/mergeSelfDevPr.js',
  'server/src/functions/applySelfDevMigrations.js',
  'server/src/functions/smokeCheckSelfDev.js',
  'server/src/functions/generateSelfDevManual.js',
  'server/src/functions/generateSelfDevPrototype.js',
];
const unscoped = [];
let looked = 0;
for (const file of files) {
  const src = read(file);
  // Capture each `prisma.project.findFirst/findMany({ … })` argument block. The
  // non-greedy bound stops at the first `})`, which is the call's own close in
  // both the one-line and multi-line forms used here.
  for (const m of src.matchAll(/prisma\.project\.(findFirst|findMany)\(\{[\s\S]{0,240}?\}\)/g)) {
    if (!/project_type:\s*'self_dev'/.test(m[0])) continue;
    looked++;
    if (!/(created_by_id|owner\s*:)/.test(m[0])) {
      unscoped.push(`${file}: ${m[0].replace(/\s+/g, ' ').slice(0, 90)}…`);
    }
  }
}
check(`self_dev lookups were found to check (parser sanity)`, looked >= 5, true);
check('every self_dev lookup is scoped by owner', unscoped, []);

console.log('\n4. the reserved project_type cannot be set through the entity API')

const entities = read('server/src/entities.js');
check('the reserved type is declared', /RESERVED_PROJECT_TYPES\s*=\s*new Set\(\['self_dev'\]\)/.test(entities), true);
check('create asserts it', /createEntity[\s\S]{0,240}?assertNotReserved\(name, rest\)/.test(entities), true);
check('update asserts it', /updateEntity[\s\S]{0,400}?assertNotReserved\(name, rest\)/.test(entities), true);
// Taking the workspace OUT of the type orphans the singleton just as effectively
// as shadowing it, so both directions are refused.
check('update also refuses changing away from it', /existing\.project_type === 'self_dev'[\s\S]{0,160}?project_type' in rest/.test(entities), true);

console.log(`\n${pass}/${pass + fail} checks passed`)
if (fail) {
  console.log('\nAn engine policy field that nothing reads is worse than no field: the')
  console.log('code around it reads as though the check exists. Wire it up, or delete')
  console.log('the field and say plainly that it is not enforced.\n')
  process.exit(1)
}
console.log('all good\n')
