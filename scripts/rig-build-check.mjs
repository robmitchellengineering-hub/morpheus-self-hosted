// Does a REAL build actually fan out? Drive one through the running rig and WATCH it.
//
// WHY THIS EXISTS, AND WHY IT IS NOT A CI GUARD
//
// `scripts/verify-lane-partition.mjs` proves the splitter, the work-unit planner, the scheduling and the merge —
// and every one of those is a pure function, so CI can run them with no install. What none of them can prove is
// the thing they add up to: **that a build driven through `chatWithMorpheus` really starts its lanes at once and
// writes every file.** The handler needs a database, a provider, a project and the apply path; CI has none of
// that, so the whole turn was asserted by reading the handler's source.
//
// This is the tier above CI: a real backend, the rig's own database, a scripted mock provider, and OBSERVATIONS
// rather than restatements.
//
//   * the lanes must OVERLAP in the event stream — at least two `coder:<lane>` rows must START before any of them
//     finishes. That is the fan-out, seen from outside, and a sequential build cannot produce it;
//   * every lane must arrive with its own NAME as its label, which is design §4.2;
//   * every planned file must actually be written (the merge lost nothing), and
//   * the written order must equal the LANE order — the determinism claim, observed rather than asserted.
//
// WHAT IT NEEDS: the rig up with the scripted build scenario. It is not a silent pass if that is missing — it
// exits 2, "cannot check", the same way scripts/check-settings.mjs does.
//
//   node scripts/dev-dock-rig.mjs down
//   MOCK_LLM_BUILD=1 node scripts/dev-dock-rig.mjs up
//   node scripts/rig-build-check.mjs
//   node scripts/dev-dock-rig.mjs down
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE = join(ROOT, 'server/data/dock-rig/state.json');
const PORT = Number(process.env.RIG_BACKEND_PORT || 4500);

function cannot(msg) {
  console.error(`\n  ✗ cannot check: ${msg}\n`);
  process.exit(2); // never a silent pass
}

if (!existsSync(STATE)) cannot(`no rig state at server/data/dock-rig/state.json — run \`node scripts/dev-dock-rig.mjs up\` first.`);
let state;
try { state = JSON.parse(readFileSync(STATE, 'utf8')); } catch { cannot('the rig state file is not readable JSON.'); }

const projectId = state?.project?.id;
// NEVER printed. It is a real credential for the rig's own database, and redacting by key name would miss it.
const token = state?.tokens?.full?.token;
if (!projectId || !token) cannot('the rig state has no project/token — re-seed with `node scripts/dev-dock-rig.mjs up`.');

let checks = 0;
let failures = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

console.log('\nA real build, driven through the running rig, fans out\n');

let res;
try {
  res = await fetch(`http://localhost:${PORT}/api/functions/chatWithMorpheus`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ projectId, message: 'build me a small rig fixture app', mode: 'build' }),
  });
} catch (err) {
  cannot(`the backend on :${PORT} did not answer (${err?.message || err}). Is the rig up?`);
}
if (!res.ok) cannot(`the backend answered ${res.status}. If the mock is not in build mode, set MOCK_LLM_BUILD=1 and restart the rig.`);

const events = [];
for (const line of (await res.text()).split('\n')) {
  const t = line.trim();
  if (!t.startsWith('{')) continue;
  try { events.push(JSON.parse(t)); } catch { /* a partial frame is not an event */ }
}

const stages = events.filter((e) => e.type === 'stage');
const result = events.find((e) => e.type === 'result')?.data || {};
const laneStages = stages.filter((s) => typeof s.stage === 'string' && s.stage.startsWith('coder:'));

// ── 1. the planner's split was accepted, and by the real splitter ───────────────────────────────────────────
const split = result.laneSplit || {};
// A REFUSED SPLIT IS "CANNOT CHECK", NOT A FAILED BUILD. At `MORPHEUS_MAX_LANES=1`, or for a plan with no
// independent units, refusing is exactly the correct behaviour — so reporting it as a wall of failed assertions
// would be blaming the build for a misconfigured check. Found by running this against N=1, where the lane
// assertions below then passed VACUOUSLY (0 === 0) and read as green.
if (!split.ok) {
  console.error(`\n  ✗ cannot check: this build did not fan out — the splitter said "${split.reason}".`);
  console.error('    That is correct behaviour at MORPHEUS_MAX_LANES=1, or for a plan whose files are not independent.');
  console.error('    There is no fan-out here to observe: unset MORPHEUS_MAX_LANES (or set it to 2 or more) and retry.\n');
  process.exit(2);
}
check('the build reported a lane split', split.ok, true);
check('…of at least two lanes', (split.lanes || []).length >= 2, true);
const laneNames = (split.lanes || []).map((l) => l.name);
check('…named, so the operator can tell them apart', laneNames.every((n) => typeof n === 'string' && n.length > 0), true);

// ── 2. THE FAN-OUT, SEEN FROM OUTSIDE ───────────────────────────────────────────────────────────────────────
// At least two lanes must START before the first lane finishes. A sequential build cannot do this: it would emit
// start/done for one lane before the next lane's start ever exists. This is the observation the pure guard cannot
// make, and the reason this file exists.
const started = laneStages.filter((s) => s.status === 'start');
const firstDoneAt = laneStages.findIndex((s) => s.status === 'done');
const startsBeforeAnyDone = firstDoneAt < 0 ? started.length : laneStages.slice(0, firstDoneAt).filter((s) => s.status === 'start').length;
check('at least two lanes STARTED before any lane finished', startsBeforeAnyDone >= 2, true);
// Guarded on ≥2 names so it cannot pass vacuously on an empty lane list — the shape that let the N=1 run report
// "one row per lane" as green with zero of each.
check('…one row per lane', laneNames.length >= 2 && started.length === laneNames.length, true);

// ── 3. each lane arrives named (design §4.2) ────────────────────────────────────────────────────────────────
const labels = started.map((s) => s.label);
check('…each row labelled with its own lane name', labels, laneNames.map((n) => `Writing ${n}`));
check('…and with an ETA from the coder’s own measured latency', started.every((s) => Number.isFinite(s.etaSeconds)), true);

// ── 4. THE MERGE LOST NOTHING, AND KEPT THE PLAN'S ORDER ────────────────────────────────────────────────────
const changed = result.changedPaths || [];
const planned = split.lanes ? split.lanes.flatMap((l) => l.files) : [];
check('every planned file was actually written', planned.length > 0 && planned.every((p) => changed.includes(p)), true);
check('…and nothing outside the plan was touched', changed.length, planned.length);
// The determinism claim, observed: the order the files were applied in is the LANE order, not the order the
// model calls happened to return. Completion order here is a race, so this is a real assertion, not a tautology.
check('…in LANE order, not completion order', changed, planned);

console.log(`\n${checks - failures}/${checks} checks passed`);
console.log(failures === 0
  ? '  a real build fanned out, named every lane, and lost no file\n'
  : '  the build did not behave as the pipeline claims\n');
process.exit(failures === 0 ? 0 : 1);
