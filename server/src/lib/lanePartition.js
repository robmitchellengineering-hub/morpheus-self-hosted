// Can this build run as independent lanes — and if so, what exactly are they?
//
// THE ONE INVARIANT (MORPHEUS design, 2026-10-09): **N lanes in, ONE deploy out.** `Morpheus_Deploy::deploy($sha)`
// applies exactly the files one commit changed, snapshots them, health-checks, and rolls back as a unit — so a
// site can only ever receive ONE commit per deploy and the undo is ONE snapshot. Fan-out is therefore a stage
// INSIDE one build (own branches → one integration branch → one PR → one deploy), never N deploys and never N
// writers on one tree (that is H9, the incident this repo opens its own rules with).
//
// ── WHY THIS MODULE IS A REFUSAL, NOT A SCHEDULER ────────────────────────────────────────────────────────
//
// The design's rule is not a lane count, it is a TEST: *fan out only when the plan can NAME the units and show
// they do not share files.* This module is that test. **The refusal IS the feature** — it turns "this looks
// parallelisable" from a mood into a claim the system can check, and it is the only thing standing between
// concurrency and two coders writing the same file at once.
//
// ── THE HAZARD IT EXISTS FOR, AND IT IS A MEASURED ONE ───────────────────────────────────────────────────
//
// The chunked coder is SEQUENTIAL for a reason that was measured, not assumed: chunk N cannot see chunk N-1's
// output, and a generated backend "routinely disagreed with itself (three files, three ideas of what `db` was,
// measured on a real run)". That is why `generateFilesChunked` grew a `writtenSoFar` argument and why the pass
// is a loop rather than a Promise.all.
//
// ⚠️ AND THE PRECISE STATE OF THE CALLER THAT USES THIS, because the difference changes what concurrency costs:
// `chatWithMorpheus.js`'s inline coder loop is sequential but **never passed prior output to the coder either** —
// it gives each step its plan, the full file list and the current on-disk content, nothing more. So concurrency
// there does not remove a guarantee that existed; it removes a *shape*. The fan-out work below therefore adds the
// missing piece in the safe direction: operations already produced are fed back to the coder **within a unit**,
// which is exactly the boundary a lane is allowed to be concurrent across — and the reason lanes joined by an
// import edge are MERGED rather than run at once.
//
// The unit of concurrency is the LANE, not the chunk: a lane's own chunks stay sequential, so the within-lane
// context can be passed and cannot be skipped.
//
// ── ROB'S RULE, AND WHICH WAY THIS FAILS ─────────────────────────────────────────────────────────────────
//
// *"The guards and mutations shouldn't stop Morpheus from being able to build anything; they should only help
// him build better."* So this function **NEVER THROWS and never blocks a build.** Every refusal means the same
// thing — *run this one sequentially, exactly as it runs today* — and the default path (no `lanes` from the
// planner) does no work at all. A bad split can cost speed. It cannot cost a build.
//
// ── WHAT IT HONESTLY CANNOT SEE (do not let the return value imply otherwise) ─────────────────────────────
//
// The dependency pass reuses `importGraph.js`, which is a regex parser over **ESM only**. So:
//   * a NON-JS lane file — above all **PHP**, the first live customer target — is not dependency-checked at
//     all, and is reported as `unchecked` rather than silently treated as independent;
//   * a planned file that does not exist yet has no content to parse, so a dependency BETWEEN two new files is
//     invisible. An existing-file→new-file edge IS caught, because the new path is in the path set.
// None of those is a reason to refuse a fan-out (that would be a guard stopping a build for something it cannot
// know). They are reasons the caller must report the split as a *proposal* with its limits attached.
//
// Run:  node scripts/verify-lane-partition.mjs

import { parseImports, resolveImport } from './importGraph.js';

/** The default fan-out. Design §6.4: cap the default at 3, make it a parameter, and run the N sweep before
 *  choosing anything permanent. Two ceilings bind here — the reviewer (N lanes = N reviews + 1 integration
 *  review, and the review is 33% of all spend at 45s a call) and contention. */
export const DEFAULT_MAX_LANES = 3;
/** Never more than this many lanes, whatever a caller passes. The measured arithmetic (Amdahl + the reviewer's
 *  cost) makes N>4 pay 2x the reviews for ~15% more speed. */
export const MAX_LANES_CEILING = 4;

const CODE_EXT = /\.(jsx?|tsx?|mjs|cjs)$/;
/** Code whose dependencies `importGraph` cannot read. Counted and reported, never assumed independent. */
const UNCHECKED_CODE_EXT = /\.(php|phtml|py|rb|go|java|cs|vue|svelte|css|scss|less)$/i;

const filesOf = (l) => (Array.isArray(l?.files) ? l.files.filter((p) => typeof p === 'string' && p) : null);
const nameOf = (l) => (typeof l?.name === 'string' && l.name.trim() ? l.name.trim() : null);

/** Every refusal has the same meaning — "run this build sequentially" — and carries why, so the operator can
 *  collapse the proposal themselves rather than being told a bare "no". */
function refusal(reason, detail, extra = {}) {
  return {
    ok: false,
    lanes: [],
    reason,
    detail,
    // What the splitter DID before refusing. A refusal that merged lanes first should say so, or the operator
    // sees "not parallelisable" with no account of the grouping the planner actually proposed.
    notes: extra.notes || [],
    merged: extra.merged || [],
    clamped: extra.clamped || false,
    unchecked: extra.unchecked || 0,
  };
}

/**
 * Judge a planner-proposed lane split and return the lanes that may safely run at once.
 *
 * @param {object} opts
 * @param {string[]} opts.plannedFiles — every path the plan says it will create or modify (the planner's own
 *   `plannedFiles`). A lane may not introduce a path outside this list.
 * @param {Array<{name: string, files: string[]}>} [opts.lanes] — the proposed split. Absent/empty → sequential.
 * @param {Array<{path: string, content: string}>} [opts.existingFiles] — the workspace as the caller already
 *   has it in memory. Used ONLY to find dependencies between lanes; content is never returned.
 * @param {number} [opts.maxLanes=DEFAULT_MAX_LANES] — clamped into [1, MAX_LANES_CEILING].
 * @returns {{ok: boolean, lanes: Array<{name: string, files: string[]}>, reason: string|null, detail: string|null,
 *   notes: string[], merged: Array<{lanes: string[], into: string, reason: string}>, clamped: boolean,
 *   unchecked: number}}
 *   `ok: true` only when **two or more** independent lanes survive. `ok: false` always means the same thing:
 *   run this build as one sequential pass, which is what it does today.
 */
export function partitionLanes(opts) {
  // `opts || {}` rather than a destructuring default: `= {}` only covers `undefined`, so a caller passing
  // `null` would throw before the try below could honour the never-throw guarantee. The guard caught exactly
  // that on its first run.
  const { plannedFiles, lanes, existingFiles = [], maxLanes = DEFAULT_MAX_LANES } = opts || {};
  try {
    return partition({ plannedFiles, lanes, existingFiles, maxLanes });
  } catch (err) {
    // The failure direction is deliberate. An unexpected error here must degrade to the existing sequential
    // path, never propagate into the build: this module is an optimisation over a working pipeline.
    return refusal(
      'error',
      `The proposed split could not be checked (${err?.message || 'unknown error'}), so this build runs sequentially.`
    );
  }
}

function partition({ plannedFiles, lanes, existingFiles, maxLanes }) {
  const planned = Array.isArray(plannedFiles) ? plannedFiles.filter((p) => typeof p === 'string' && p) : [];
  if (planned.length === 0) {
    return refusal('no-planned-files', 'The plan named no files, so there is nothing to split.');
  }
  if (!Array.isArray(lanes) || lanes.length === 0) {
    return refusal('no-lanes', 'The plan proposed no split, so this build runs as one sequential pass.');
  }
  if (lanes.length < 2) {
    return refusal('single-lane', 'The plan proposed a single lane, so there is nothing to run in parallel.');
  }

  // ── shape ──────────────────────────────────────────────────────────────────────────────────────────────
  const proposed = [];
  for (const l of lanes) {
    const name = nameOf(l);
    if (!name) {
      return refusal('bad-lane-name', 'A proposed lane has no name, so its state and cost could not be reported per lane.');
    }
    const files = filesOf(l);
    if (!files) {
      return refusal('bad-lane-files', `Lane "${name}" does not list its files, so which files it writes is unknown.`);
    }
    if (files.length === 0) {
      return refusal('empty-lane', `Lane "${name}" lists no files, so it would be a worker with nothing to do.`);
    }
    proposed.push({ name, files });
  }

  const seenNames = new Set();
  for (const l of proposed) {
    if (seenNames.has(l.name)) {
      // Names are the reporting key (design §4.2: per-lane state, cost and verify verdict), so a repeat would
      // silently merge two lanes' rows into one.
      return refusal('duplicate-lane-name', `Two proposed lanes are both called "${l.name}", so their results could not be told apart.`);
    }
    seenNames.add(l.name);
  }

  const plannedSet = new Set(planned);
  for (const l of proposed) {
    for (const f of l.files) {
      if (!plannedSet.has(f)) {
        // The plan's own file list is the contract the coder implements from — "a file missing from this list
        // will not get written". A lane inventing a path is a split we cannot reason about.
        return refusal('unplanned-file', `Lane "${l.name}" lists "${f}", which the plan's own file list does not contain.`);
      }
    }
  }

  // ── the design's rule: two lanes may not name the same file ────────────────────────────────────────────
  const owner = new Map();
  for (const l of proposed) {
    for (const f of l.files) {
      if (owner.has(f)) {
        // THE refusal. Lanes that share a file are not independent: run at once, two coders write the same
        // path and the last completion wins — which is H9 at file scale, and it is unrecoverable because
        // nothing in the result says it happened.
        return refusal(
          'shared-file',
          `"${f}" is in both lane "${owner.get(f)}" and lane "${l.name}" — lanes that share a file are not independent, so this build runs sequentially.`
        );
      }
      owner.set(f, l.name);
    }
  }

  // Every planned file must land in exactly one lane. A file in NO lane is the quiet one: the split looks
  // clean, the lanes all finish green, and a file the plan called for was never written by anybody.
  const missing = planned.filter((p) => !owner.has(p));
  if (missing.length > 0) {
    const shown = missing.slice(0, 3).join(', ') + (missing.length > 3 ? `, +${missing.length - 3} more` : '');
    return refusal('missing-file', `${missing.length} planned file(s) are in no lane (${shown}) — a file in no lane is written by nobody, so this split is refused.`);
  }

  // ── dependencies: merge lanes that would need to see each other ────────────────────────────────────────
  // The planner groups by FEATURE ("product templates", "the bookings form"), and two features can be
  // code-dependent without sharing a file — that is exactly the `writtenSoFar` hazard. Merging them re-creates
  // the sequential pass for those files only, which is always safe, so this narrows a split rather than
  // refusing it. Merging is also order-stable: a merged lane keeps the position of its earliest member.
  const notes = [];
  const merged = [];
  let working = proposed.map((l, i) => ({ name: l.name, files: l.files.slice(), at: i }));

  const { pairs, examples, unchecked } = crossingDependencies(working, existingFiles, planned);
  if (pairs.length > 0) {
    working = mergeGroups(working, pairs);
    for (const g of working.filter((l) => l.union.length > 1)) {
      // `examples` carries the lane NAMES, not their indices: by this point the indices refer to a lane list
      // that no longer exists, and comparing them against `union` silently matched nothing.
      const ex = examples.find((e) => g.union.includes(e.fromName) && g.union.includes(e.toName));
      merged.push({ lanes: g.union, into: g.name, reason: 'dependency' });
      notes.push(
        `Merged ${g.union.length} lanes that depend on each other (${g.union.join(' + ')}) — ` +
        (ex ? `${ex.importer} imports ${ex.target}` : 'one lane imports another') + '.'
      );
    }
  }

  // ── clamp to the cap, by merging the smallest lanes ────────────────────────────────────────────────────
  // Merging is the safe way to shrink a partition (it only ever serialises), so a plan proposing more lanes
  // than the cap keeps its coverage and loses only fan-out. Greedy smallest-first keeps the biggest
  // independent units whole, which is the shape that gives the wall-clock win.
  const cap = clampCap(maxLanes);
  let clamped = false;
  while (working.length > cap) {
    const order = working.map((l, i) => i).sort((a, b) => working[a].files.length - working[b].files.length || a - b);
    const [i, j] = order.slice(0, 2).sort((a, b) => a - b);
    working = mergeGroups(working, [[i, j]]);
    clamped = true;
  }
  if (clamped) {
    notes.push(`Clamped the split to ${cap} lanes (the ceiling), keeping every file in exactly one lane.`);
  }

  if (working.length < 2) {
    // Everything merged into one. That is not a failure of the plan — it is the honest answer that this build
    // has no two independent units, so it runs exactly as it does today.
    return refusal('no-independent-units', 'Every proposed lane depends on another, so there is nothing that can safely run at once.', {
      notes,
      merged,
      unchecked,
    });
  }

  if (unchecked > 0) {
    notes.push(
      `${unchecked} non-JS file(s) in these lanes could not be dependency-checked (the import graph reads ESM only), ` +
      'so the split is a proposal, not a proof.'
    );
  }

  return {
    ok: true,
    lanes: working.map((l) => ({ name: l.name, files: l.files })),
    reason: null,
    detail: null,
    notes,
    merged,
    clamped,
    unchecked,
  };
}

function clampCap(maxLanes) {
  const n = Number.isFinite(maxLanes) ? Math.floor(maxLanes) : DEFAULT_MAX_LANES;
  return Math.max(1, Math.min(MAX_LANES_CEILING, n));
}

/**
 * Lane index pairs joined by a real import edge. Only lanes are considered — an edge from a planned file that
 * exists to another planned file, resolving through `importGraph.resolveImport`, which is what makes this a
 * check rather than a guess.
 */
function crossingDependencies(lanes, existingFiles, planned) {
  const laneOf = new Map();
  lanes.forEach((l, i) => l.files.forEach((f) => laneOf.set(f, i)));

  const pathSet = new Set(planned);
  const content = new Map();
  for (const f of Array.isArray(existingFiles) ? existingFiles : []) {
    if (!f || typeof f.path !== 'string') continue;
    pathSet.add(f.path);
    if (typeof f.content === 'string') content.set(f.path, f.content);
  }

  const pairKeys = new Map();
  const examples = [];
  for (const [path, src] of content) {
    const from = laneOf.get(path);
    if (from == null) continue;
    if (!CODE_EXT.test(path)) continue; // its dependencies are not readable — counted below, not guessed
    for (const imp of parseImports(src)) {
      let target;
      try {
        target = resolveImport(path, imp.spec, pathSet);
      } catch {
        continue; // an unresolvable specifier is not evidence of independence either way
      }
      if (!target) continue;
      const to = laneOf.get(target);
      if (to == null || to === from) continue;
      const key = `${Math.min(from, to)}|${Math.max(from, to)}`;
      if (!pairKeys.has(key)) {
        pairKeys.set(key, [from, to]);
        examples.push({ from, to, fromName: lanes[from].name, toName: lanes[to].name, importer: path, target });
      }
    }
  }

  // Code files in a lane that this check cannot read. Reported so a green split over a PHP lane is never
  // mistaken for a verified one — the first live customer target is WordPress.
  const unchecked = [...laneOf.keys()].filter((p) => UNCHECKED_CODE_EXT.test(p)).length;

  return { pairs: [...pairKeys.values()], examples, unchecked };
}

/** Union-find over lane indices, then rebuild the lane list preserving original positions. */
function mergeGroups(lanes, pairs) {
  const parent = lanes.map((_, i) => i);
  const find = (i) => {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    while (parent[i] !== r) { const next = parent[i]; parent[i] = r; i = next; }
    return r;
  };
  for (const [a, b] of pairs) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }

  const groups = new Map();
  lanes.forEach((l, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(l);
  });

  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([root, members]) => {
      // The merged lane takes its earliest member's position AND name; `into` in `merged` records the union so
      // the operator can see what the splitter actually did rather than a silently renamed lane.
      const first = members.reduce((best, m) => (m.at < best.at ? m : best), members[0]);
      return {
        name: first.name,
        files: members.flatMap((m) => m.files),
        at: Math.min(...members.map((m) => m.at)),
        union: members.map((m) => m.name),
        root,
      };
    });
}

// ── the fan-out parameter ───────────────────────────────────────────────────────────────────────────────
//
// Design §6.4: *"Cap the default at 3, make it a parameter, and run the N sweep before choosing anything
// permanent."* This is that parameter. It is an environment variable rather than a database setting because the
// sweep is an OPERATIONAL measurement — it has to be changed between two runs of the same task, and a
// `platform_settings` write needs a deploy's worth of ceremony for something that is read once per build.
//
// **`1` means sequential, and that is the point of the whole exercise**: it makes the measurement a
// one-variable comparison against today's behaviour rather than against a remembered number. It is also the
// switch to reach for if concurrency ever misbehaves in production — one variable, no deploy.
//
// Unreadable input falls back to the default rather than throwing: a typo in an env var must not stop a build.
export const MAX_LANES_ENV = 'MORPHEUS_MAX_LANES';

export function maxLanesFromEnv(env = process.env) {
  const raw = env?.[MAX_LANES_ENV];
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_MAX_LANES;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n)) return DEFAULT_MAX_LANES;
  return clampCap(n);
}

// ── work units, and merging them back ───────────────────────────────────────────────────────────────────
//
// The coder is chunked by files-per-step, and a lane chunks its OWN files — so a chunk never contains files from
// two lanes, which is the property that makes the units independently writable. These two functions are split
// out from the build loop on purpose: they are the parts that can be WRONG in a way a test can see, and the part
// that cannot (the model call) stays in chatWithMorpheus.js.

/**
 * Plan the coder's work units from a lane verdict, in the order their output must be merged.
 *
 * @param {object} opts
 * @param {object|null} [opts.laneSplit] — a `partitionLanes()` verdict. Anything not `ok` means one unit.
 * @param {string[]} [opts.plannedFiles]
 * @param {number} [opts.filesPerStep=3]
 * @param {number} [opts.maxLanes=DEFAULT_MAX_LANES]
 * @returns {{concurrent: boolean, units: Array<{name: string|null, chunks: string[][]}>}}
 *   With `maxLanes < 2`, or no accepted split, this is exactly ONE unit holding today's flat chunking — the
 *   sequential build, unchanged, which is what makes N=1 a fair baseline rather than a second code path.
 */
export function planCoderWork({ laneSplit, plannedFiles, filesPerStep = 3, maxLanes = DEFAULT_MAX_LANES } = {}) {
  const planned = Array.isArray(plannedFiles) ? plannedFiles.filter((p) => typeof p === 'string' && p) : [];
  const step = Number.isFinite(filesPerStep) && filesPerStep >= 1 ? Math.floor(filesPerStep) : 3;
  const chunk = (files) => {
    const out = [];
    for (let i = 0; i < files.length; i += step) out.push(files.slice(i, i + step));
    return out;
  };

  const lanes = laneSplit?.ok && Array.isArray(laneSplit.lanes) && laneSplit.lanes.length >= 2 ? laneSplit.lanes : null;
  if (!lanes || clampCap(maxLanes) < 2) {
    return { concurrent: false, units: planned.length > 0 ? [{ name: null, chunks: chunk(planned) }] : [] };
  }
  return { concurrent: true, units: lanes.map((l) => ({ name: l.name, chunks: chunk(Array.isArray(l.files) ? l.files : []) })) };
}

/**
 * Merge settled work units back into one list, in UNIT ORDER — never in completion order.
 *
 * ⚠️ WHY THIS IS A FUNCTION AND NOT A LOOP IN THE CALLER: the order of `fileOperations` decides the order the
 * files are applied and therefore what the reviewer reads. Merging in completion order would make the build
 * nondeterministic — the same plan producing a different result each run — which is precisely the property that
 * makes a parallel build hard to reason about. `Promise.allSettled` preserves input order, so this is a merge of
 * an ordered list, and the guard asserts it.
 *
 * Rejected entries are skipped: the caller asks `firstLaneError()` first, so that a failure is reported by the
 * unit that comes FIRST rather than whichever model call happened to fail fastest.
 */
export function mergeLaneResults(results) {
  const ops = [];
  const truncated = [];
  let model;
  for (const r of Array.isArray(results) ? results : []) {
    if (!r || typeof r !== 'object') continue;
    if (Array.isArray(r.ops)) ops.push(...r.ops);
    if (Array.isArray(r.truncated)) truncated.push(...r.truncated);
    if (r.model) model = r.model;
  }
  return { ops, truncated, model };
}

/** The first rejection in unit order, or null. Deterministic on purpose — see `mergeLaneResults`. */
export function firstLaneError(settled) {
  for (const r of Array.isArray(settled) ? settled : []) {
    if (r && r.status === 'rejected') return r.reason;
  }
  return null;
}

/**
 * Run the work units and merge them — the scheduling half, with the model call INJECTED.
 *
 * ⚠️ WHY THIS IS A FUNCTION AND NOT FOUR LINES INSIDE THE HANDLER. It was inside the handler, and that made the
 * single most important claim about this feature untestable: **that the units actually run at once.** The guard
 * could only regex-match `Promise.allSettled` in a 2,600-line file — which is a statement about the text, not
 * about the behaviour, and it would keep passing if the call were replaced by a sequential loop.
 *
 * With `runUnit` injected, the claim becomes executable: three units that each sleep 150ms must finish in ~150ms,
 * not ~450ms; the sequential path must really queue; the merge must be unit order even when completion order is
 * reversed; and a failure must be the FIRST unit's, not whichever failed fastest.
 *
 * `concurrent: false` keeps today's exact throw behaviour — the first failure propagates immediately, with no
 * `allSettled` wrapper to swallow it.
 *
 * @param {object} opts
 * @param {Array<{name: string|null, chunks: string[][]}>} opts.units
 * @param {(unit: object) => Promise<{ops: object[], truncated?: string[], model?: string}>} opts.runUnit
 * @param {boolean} opts.concurrent
 * @returns {Promise<{ops: object[], truncated: string[], model: string|undefined}>}
 */
export async function runLaneUnits({ units, runUnit, concurrent }) {
  const list = Array.isArray(units) ? units : [];
  if (!concurrent) {
    const values = [];
    for (const u of list) values.push(await runUnit(u));
    return mergeLaneResults(values);
  }
  const settled = await Promise.allSettled(list.map((u) => runUnit(u)));
  const firstErr = firstLaneError(settled);
  if (firstErr) throw firstErr;
  return mergeLaneResults(settled.map((s) => s.value));
}

// ── per-lane verdicts ───────────────────────────────────────────────────────────────────────────────────────
//
// Design §4.2: "N lanes, each with its own state". The state it is missing is the one that matters — whether the
// lane's own files came out clean.
//
// ⚠️ COMPUTED AFTER THE GATES, NOT DURING THE LANE, AND THAT IS THE WHOLE DESIGN. A lane's files routinely do not
// parse WHILE it is writing them: the syntax gate and its fix loop run afterwards, on the integrated change set,
// and routinely repair them. Marking a lane failed at the end of its own coding pass would therefore cry wolf on
// most multi-file builds — and a verdict that is usually wrong is worse than no verdict, because it teaches the
// operator to ignore the marker.
//
// So this answers the question at the point where the answer is final: **given everything the gates still object
// to, which lane does each objection belong to?** A lane with no findings needs nothing; a lane with findings
// carries them on its own row.
//
// `unowned` is returned rather than dropped: a finding about a file that is in NO lane (the coder wrote something
// the plan never listed) has to be visible, or the one case the lanes cannot explain is the one case that goes
// missing.
//
// ⚠️ AND THE FILE HAS TO BE READ BACK OUT OF A DISPLAY STRING, WHICH IS NOT HOW THIS WAS FIRST WRITTEN. The gate
// lists in chatWithMorpheus.js do not hold objects — every one of them is built as
// `` `${e.file}${e.line ? ':' + e.line : ''} — ${e.text}` `` because those same arrays are shown to the operator.
// A first version of this function looked only for an object's `file`/`path`, so fed the real lists it found no
// owner for ANY finding, attributed everything to `unowned`, and reported every lane clean — a per-lane verdict
// that silently says "all good" for a build with a file that does not parse. Shape tolerance here is not
// defensive padding; it is the difference between the feature working and the feature lying.
const DISPLAY_FINDING = /^(.+?)(?::\d+)?\s+—\s+/;

/** The file a finding is about: a bare path, an object's `file`/`path`, or the path inside "path:line — text". */
export function fileOfFinding(raw) {
  if (typeof raw === 'string') {
    const m = DISPLAY_FINDING.exec(raw);
    return m ? m[1] : raw;
  }
  return raw?.file ?? raw?.path ?? null;
}
export function laneVerdicts({ lanes, findings } = {}) {
  const list = Array.isArray(lanes) ? lanes.filter((l) => l && typeof l.name === 'string') : [];
  const owner = new Map();
  for (const l of list) {
    for (const f of (Array.isArray(l.files) ? l.files : [])) owner.set(f, l.name);
  }

  const verdicts = list.map((l) => ({
    name: l.name,
    files: (Array.isArray(l.files) ? l.files : []).slice(),
    issues: [],
  }));
  const byName = new Map(verdicts.map((v) => [v.name, v]));

  const unowned = [];
  for (const raw of Array.isArray(findings) ? findings : []) {
    const file = fileOfFinding(raw);
    const name = file ? owner.get(file) : null;
    if (name === undefined || name === null) { unowned.push(raw); continue; }
    byName.get(name).issues.push(raw);
  }

  return { verdicts, unowned };
}

/** The suffix a lane's own row carries when it has findings — e.g. "2 files need attention". */
export function describeLaneIssues(count) {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  if (n === 0) return '';
  return `${n} file${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} attention`;
}
