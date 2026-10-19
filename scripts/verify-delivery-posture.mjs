// Can the operator actually run what Morpheus builds them, or only export it?
//
// WHY THIS EXISTS. The market evidence for the "it ships" work is unusually consistent, and one finding
// sits under all of it: every AI app builder exports the SOURCE happily, and the thing users discover
// they cannot leave is the MANAGED BACKEND. Documented cases include a school app with 189 tables whose
// owner "could not open his own database", and 12 GB locked for four days by a false-positive
// moderation flag. Lovable's own docs admit there is no one-click migration off Lovable Cloud.
//
// Morpheus had the same shape and did not notice, because nothing had joined the two halves up:
//
//   * `DEFAULT_COMPONENTS` was chosen as the "best free-tier combo" — Cloudflare Workers + Supabase for
//     api_host, database, auth AND storage. Every option in every component list was a LIVE managed
//     service, so the default path ended with the operator's data in somebody else's account.
//   * `self-hosted-docker`, `standalone`, `self-hosted-pg` and `sqlite-local` all existed as ALTERNATIVES,
//     and `jwt-self` produced real auth with bcrypt — so the capability was there and simply never the
//     recommendation.
//   * Nothing validated the COMBINATION. `api_host: self-hosted-docker` with `database: supabase-pg` is
//     not a leaner stack, it is an incoherent one: an API on the operator's machine that needs a cloud
//     account to boot. An operator could pick their way into a stack that runs nowhere.
//   * And nothing told the code generator that a self-contained stack has to arrive with ONE command.
//     Files plus a README full of steps is the managed-backend problem moved onto the operator's disk.
//
// So this guard asserts the three things that make the claim true: a posture is a COMPLETE stack, a
// stack can be asked whether it needs an account, and the generator is told to produce one command when
// it does not.
//
// Run:  node scripts/verify-delivery-posture.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DELIVERY_POSTURES, DEFAULT_COMPONENTS, getPosture, applyPosture, postureOf,
  stackRequirement, getServiceOption, selfContainedRequirement,
} from '../server/src/lib/infrastructureComponents.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
// Comments out before structural assertions. This suite has had seven checks fooled by their own prose
// today — including one in this very file's subject matter — so prose never counts as evidence.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

const COMPONENT_TYPES = ['api_host', 'database', 'auth', 'file_storage', 'cache'];

console.log('\n1. a posture is a COMPLETE stack, not a preference');
for (const p of DELIVERY_POSTURES) {
  check(`${p.id}: names every component the backend has`, COMPONENT_TYPES.every((t) => t in p.components), true);
  check(`${p.id}: every service id it names exists`, COMPONENT_TYPES.every((t) => Boolean(getServiceOption(t, p.components[t]))), true);
  check(`${p.id}: states what it guarantees`, typeof p.guarantee === 'string' && p.guarantee.length > 20, true);
  check(`${p.id}: states what it costs the operator, not just what it gives`, typeof p.tradeoff === 'string' && p.tradeoff.length > 20, true);
}
check('there is exactly one self-contained way to run an app', DELIVERY_POSTURES.filter((p) => stackRequirement(p.components).selfContained).map((p) => p.id).sort().join(','), 'container,self-hosted');

console.log('\n2. the self-contained postures really are self-contained');
// The claim the whole feature rests on. If this ever fails, "runs on your own machine" is a lie printed
// next to a stack that needs a Supabase account.
for (const id of ['self-hosted', 'container']) {
  const need = stackRequirement(applyPosture(id));
  check(`${id}: needs no account with anyone`, need.selfContained, true);
  check(`${id}: and names none`, need.needsAccounts, []);
}
// And the managed one is honest about what it needs — all FOUR services, not one. The first version of
// stackRequirement inferred this from a missing deployType and reported one, because supabase-pg has no
// deployType at all: a property inferred from the absence of a different one.
const cloud = stackRequirement(applyPosture('cloud'));
check('cloud: is NOT claimed to be self-contained', cloud.selfContained, false);
check('cloud: names all four services it needs, not a subset', cloud.needsAccounts.map((n) => n.id).sort().join(','), 'cloudflare-workers,supabase-auth,supabase-pg,supabase-storage');
check('…and each of those is a real service in the registry', cloud.needsAccounts.every((n) => Boolean(getServiceOption(n.type, n.id))), true);

console.log('\n3. the default stack is no longer a managed-backend trap by accident');
// Not asserting that the default CHANGED — the cloud default may well be right for the default path.
// Asserting that whatever it is, we can SAY whether it needs an account, which was impossible before.
const def = stackRequirement(DEFAULT_COMPONENTS);
check('the default stack can be classified at all', typeof def.selfContained, 'boolean');
check('…and the classification is not vacuous — the cloud default needs accounts', def.selfContained, false);
check('…and it names them', def.needsAccounts.length >= 3, true);
check('an unknown service does not crash the classifier', stackRequirement({ api_host: 'not-a-service' }).selfContained, true);

console.log('\n4. a mixed stack is reported honestly, which is the coherence gap');
// The specific incoherence that prompted this: an API on the operator's machine talking to a database
// in the cloud. It is not self-contained, and saying so is the point.
const mixed = stackRequirement({ api_host: 'self-hosted-docker', database: 'supabase-pg', auth: 'jwt-self', file_storage: 'local', cache: 'none' });
check('a self-hosted API over a cloud database is NOT called self-contained', mixed.selfContained, false);
check('…and it names the one service that breaks it', mixed.needsAccounts.map((n) => n.id), ['supabase-pg']);
check('"none" never counts as needing an account', stackRequirement({ file_storage: 'none', cache: 'none' }).selfContained, true);
check('an empty component set is self-contained, not unknown', stackRequirement({}).selfContained, true);
check('a missing argument does not crash', stackRequirement().selfContained, true);

console.log('\n5. an unknown posture is refused, never defaulted');
// This is the security-relevant one. Quietly falling back to the cloud stack for a mistyped
// "self-hosted" would put an operator's data in an account they explicitly did not ask for.
check('applyPosture returns null for an unknown id', applyPosture('typo'), null);
check('…not the default', applyPosture('typo') === DEFAULT_COMPONENTS, false);
check('getPosture returns null too', getPosture('typo'), null);
check('a known id round-trips', postureOf(applyPosture('container')), 'container');
check('a partial or foreign component set matches no posture', postureOf({ api_host: 'vercel' }), null);
check('a genuine prefix match still matches', postureOf({ ...applyPosture('cloud') }), 'cloud');

console.log('\n6. the planner is told the posture, and cannot substitute a managed service');
const plan = code(read('server/src/functions/planBackend.js'));
check('planBackend accepts a posture', /posture: requestedPosture/.test(plan), true);
check('…refuses an unknown one instead of defaulting', /Unknown delivery posture/.test(plan) && /status: 400/.test(plan), true);
check('…tells the architect not to substitute a managed service', /do not substitute a managed service/.test(plan), true);
check('…forbids managed alternatives within a self-contained stack', /no managed alternative/.test(plan), true);
check('…and stamps the decision onto the saved plan', /plan\.posture = posture\.id/.test(plan), true);
check('the plan still works with no posture at all — the old behaviour survives', /if \(requestedPosture && !posture\)/.test(plan), true);

console.log('\n7. a self-contained stack is told to arrive with ONE command');
// BEHAVIOUR, by calling the function the generator calls. The first version of this section asserted the
// words appeared in generateBackend.js — and deleting the injection line did NOT fail it, because the
// words still appeared in the now-unused string. An assertion satisfied by a dead constant proves
// nothing. The requirement is a pure function of the components precisely so it can be called here.
const req = selfContainedRequirement(applyPosture('self-hosted'));
for (const [what, re] of [
  ['one command starts everything', /ONE command must start everything/],
  ['the database is created locally', /created locally/],
  ['env vars have working defaults or are generated', /working local default or be generated/],
  ['secrets are gitignored, not placeholders', /never a placeholder like "changeme"/],
  ['the README opens with that one command', /README\.md must open with that one command/],
]) check(`the requirement says ${what}`, re.test(req), true);
// The other direction, which is what stops it becoming a claim: a stack that needs an account is never
// handed the instruction, so no operator is told a cloud app runs offline.
check('a cloud stack gets NO requirement at all', selfContainedRequirement(applyPosture('cloud')), '');
check('a mixed stack gets none either', selfContainedRequirement({ api_host: 'self-hosted-docker', database: 'supabase-pg' }), '');
check('a missing component set gets none, rather than a guess', selfContainedRequirement(undefined).length > 0, false);
check('the container posture gets it too', /ONE command must start everything/.test(selfContainedRequirement(applyPosture('container'))), true);
// …and that the generator actually calls it, which the behaviour above cannot see on its own.
const gen = code(read('server/src/functions/generateBackend.js'));
check('the generator calls the requirement function', /selfContainedRequirement\(components\)/.test(gen), true);
check('…and interpolates it INTO the brief, not merely computes it',
  read('server/src/functions/generateBackend.js').includes('${runnableRequirement}'), true);

console.log('\n8. every posture is reachable from the plan the UI reads');
// The UI reads `plan.components[].suggested`. If a posture's ids are not injectable there, choosing a
// posture would silently do nothing on screen.
const planRaw = read('server/src/functions/planBackend.js');
check('the posture\'s components are injected into plan.components', /plan\.components = \(plan\.components \|\| \[\]\)\.map/.test(planRaw), true);
check('…including any the architect omitted entirely', /if \(!plan\.components\.some\(\(c\) => c\.type === type\)\)/.test(planRaw), true);
check('…and the operator can see WHY each was chosen', /Chosen by the "\$\{posture\.label\}" posture/.test(planRaw), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ an operator could be told they own an app they cannot run without someone else\'s account\n');
  process.exit(1);
}
console.log('"runs on your own machine" is a stack you can point at, not a sentence in a dropdown\n');
