// Are the two copies of the infrastructure registry still the same registry?
//
// WHY THIS EXISTS. There are TWO copies of this module and nothing kept them in step:
//
//   base44/shared/infrastructureComponents.ts   ← the frontend imports THIS one
//   server/src/lib/infrastructureComponents.js  ← the backend uses this one
//
// `server/src/lib`'s header says it is "Ported from base44/shared/… verbatim", and there is no sync
// script, no generated copy, and — until now — no check. So they drift silently, and the drift is
// invisible in the worst way: each copy is individually valid, both test suites pass, and the only
// symptom is that the UI and the backend disagree about what a stack is.
//
// That is not hypothetical. It happened on the change that added delivery postures: the flags and
// functions went into the SERVER copy, and because `BackendPanel.jsx` imports the base44 one, the
// entire feature was invisible in the UI while every guard passed. It was found only by reading the
// import line. Then, while writing THIS guard, the reverse half was caught live — the postures reached
// the UI copy but the `selfContained` flags did not, so the UI would have reported the self-hosted
// stack as needing accounts.
//
// So this compares the two modules AS DATA, by importing both and asking them the same questions.
// Comparing source text would be defeated by the type annotations that legitimately differ (one is
// `.ts`, one is `.js`), and a normalised-text comparison is the kind of check that passes for the
// wrong reason. Asking each module the same questions cannot be.
//
// Run:  node scripts/verify-registry-parity.mjs
import { getServiceOption as serverGetService, COMPONENTS as SERVER_COMPONENTS,
  DEFAULT_COMPONENTS as SERVER_DEFAULTS, DELIVERY_POSTURES as SERVER_POSTURES,
  applyPosture as serverApplyPosture, stackRequirement as serverStackRequirement,
  selfContainedRequirement as serverSelfContainedRequirement,
} from '../server/src/lib/infrastructureComponents.js';

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

// The frontend copy is TypeScript. Node 22 strips the annotations, and CI runs 22 — but if a future
// runtime cannot, that must be REPORTED rather than silently skipped: a guard that quietly declines to
// check is the "a pass from a check that examined nothing is not a pass" failure this repo already
// bans for its coverage gates.
const UI_PATH = '../base44/shared/infrastructureComponents.ts';
let ui = null;
try {
  ui = await import(UI_PATH);
} catch (err) {
  console.log(`\n  ⚠  could not load ${UI_PATH} — ${err.message}`);
  console.log('     Parity CANNOT be checked on this runtime. That is not a pass.');
  console.log('\n  0/0 checks passed — NOT VERIFIED\n');
  process.exit(1);
}

console.log('\n1. both copies expose the same API');
// The names the UI actually imports, plus every function the posture feature added. Asserted by NAME
// rather than by comparing key lists: the `.ts` copy carries type-only exports the `.js` one cannot,
// so an equality of key sets would fail for a legitimate reason and teach nothing.
const REQUIRED = ['COMPONENTS', 'DEFAULT_COMPONENTS', 'getServiceOption', 'hasCredentials',
  'DELIVERY_POSTURES', 'getPosture', 'applyPosture', 'postureOf', 'stackRequirement', 'selfContainedRequirement'];
const missing = REQUIRED.filter((k) => !(k in ui));
check('the UI copy exports every function the feature needs', missing, []);

console.log('\n2. the same services, with the same ids');
const flatten = (mod) => Object.fromEntries((mod.COMPONENTS || []).map((c) => [c.type, (c.options || []).map((o) => o.id)]));
check('component types match', Object.keys(flatten(ui)).sort().join(','), Object.keys(flatten({ COMPONENTS: SERVER_COMPONENTS })).sort().join(','));
const uiServices = flatten(ui);
const serverServices = flatten({ COMPONENTS: SERVER_COMPONENTS });
for (const type of Object.keys(serverServices)) {
  check(`${type}: the same service ids, in the same order`, uiServices[type], serverServices[type]);
}

console.log('\n3. the same defaults');
check('DEFAULT_COMPONENTS agree', ui.DEFAULT_COMPONENTS, SERVER_DEFAULTS);

console.log('\n4. the same postures — the whole point of the feature');
check('posture ids agree', (ui.DELIVERY_POSTURES || []).map((p) => p.id).join(','), (SERVER_POSTURES || []).map((p) => p.id).join(','));
for (const serverPosture of SERVER_POSTURES || []) {
  const uiPosture = (ui.DELIVERY_POSTURES || []).find((p) => p.id === serverPosture.id);
  check(`${serverPosture.id}: the same component set`, uiPosture?.components, serverPosture.components);
  check(`${serverPosture.id}: the same guarantee text`, uiPosture?.guarantee, serverPosture.guarantee);
}

console.log('\n5. the same ANSWERS — which is what the UI actually renders');
// The highest-value comparison, and the one that caught the live drift: it is not enough for both copies
// to list the same services, they must classify the same stacks the same way. A missing `selfContained`
// flag leaves the ids identical and the answer wrong.
for (const posture of SERVER_POSTURES || []) {
  check(`${posture.id}: both copies agree on self-containment`,
    ui.stackRequirement(ui.applyPosture(posture.id)).selfContained, serverStackRequirement(serverApplyPosture(posture.id)).selfContained);
  check(`${posture.id}: both name the same accounts needed`,
    ui.stackRequirement(ui.applyPosture(posture.id)).needsAccounts.map((n) => n.id).sort(),
    serverStackRequirement(serverApplyPosture(posture.id)).needsAccounts.map((n) => n.id).sort());
}
// Every service, one at a time — a missing flag on ANY of them shows up here rather than only on the
// postures that happen to use it.
const perService = [];
for (const [type, ids] of Object.entries(serverServices)) {
  for (const id of ids) {
    const stack = { [type]: id };
    const a = ui.stackRequirement(stack).selfContained;
    const b = serverStackRequirement(stack).selfContained;
    if (a !== b) perService.push(`${type}=${id} (ui:${a} server:${b})`);
  }
}
check('every single service classifies identically in both copies', perService, []);
check('…and the comparison is not vacuous — it inspected every service',
  Object.values(serverServices).reduce((n, ids) => n + ids.length, 0) >= 18, true);

console.log('\n6. the same generated requirement');
for (const posture of SERVER_POSTURES || []) {
  check(`${posture.id}: the instruction handed to the model is byte-identical`,
    ui.selfContainedRequirement(ui.applyPosture(posture.id)), serverSelfContainedRequirement(serverApplyPosture(posture.id)));
}

console.log('\n7. the same lookup behaviour');
check('an unknown service is unknown in both', [Boolean(ui.getServiceOption('database', 'nope')), Boolean(serverGetService('database', 'nope'))].join(','), 'false,false');
check('a known service resolves in both', [Boolean(ui.getServiceOption('api_host', 'standalone')), Boolean(serverGetService('api_host', 'standalone'))].join(','), 'true,true');
// JSON each side separately: `[null, null].join(',')` is "," not "null,null", which made this assert
// something other than what it reads as.
check('an unknown posture is refused in both', [ui.applyPosture('typo'), serverApplyPosture('typo')].map((v) => JSON.stringify(v)).join(','), 'null,null');

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ the UI and the backend disagree about what a stack is — one copy is stale\n');
  process.exit(1);
}
console.log('the two copies are one registry, and the UI renders what the backend believes\n');
