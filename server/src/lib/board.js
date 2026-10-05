// The board: a signal path the user arranges, saved in the project, compiled into the plugin.
//
// ── WHY THIS IS A BLOCK REGISTRY RATHER THAN A CHAIN NAME ────────────────────────────────────────────────
// `ampChain.js` answers "which signal path is this" with a name — `amp` or `plain`. That was enough while
// Morpheus generated exactly one thing. A pedalboard is a list the USER orders, so the answer has to become
// data: an ordered list of blocks with identities, which the UI edits and the generator reads.
//
// ⭐ THE ORDER IS THE FEATURE, AND IT IS ALSO THE HAZARD. Everything here is arranged around one decision
// from PiPedal's model — an item carries an `instanceId` that is NOT its position — because the failure it
// prevents is silent. A saved value, a MIDI binding, a host's automation lane: anything keyed by position
// follows the WRONG block the moment a user drags one past another. Nothing throws, nothing fails to build,
// and the user discovers it as "my automation controls the wrong knob now". So:
//
//   • `instanceId` is a monotonic integer, never reused, assigned once and never derived from position;
//   • a BYPASSED block keeps its parameters. Bypass is a state, not an absence — dropping the parameter
//     would renumber every parameter after it, which is the same corruption wearing a different hat. (It is
//     also why `ampChain.js`'s GATE_OFF_DB is a state rather than a very low threshold.)
//
// ── WHAT IS IN THE CATALOGUE, AND WHAT IS NOT ────────────────────────────────────────────────────────────
// The six blocks that already exist, because the loop that runs them is proven: input trim, gate, tone
// stack, the neural model, the cabinet, output level. A delay or a compressor is a NEW block kind and
// belongs in its own change — the point of a registry is that adding one is a new entry here and no change
// anywhere else, and that claim is only worth making if it is kept true.
import { AMP_CHAIN, PLAIN_CHAIN, PARAM_ORDER, chainHas, chainParams, modelStageIndex } from './ampChain.js';
import { TONE_BANDS, TONE_KEYS } from './audio/toneStack.js';

/**
 * ⚠️ ONE OF EACH, FOR NOW, AND IT IS ENFORCED RATHER THAN ASSUMED.
 *
 * The parameter keys below are per-KIND (`bass`, `gate`, `output`), and the emitted C++ turns them into
 * `PARAM_BASS`-style constants, so two delays would collide on `PARAM_TIME`. The honest options were to
 * scope every key by its `instanceId` now, or to refuse the second block with a reason.
 *
 * Refusing is the smaller, safer change and it cannot corrupt anything; the `instanceId` is already carried
 * on every item and every stage precisely so that key scoping is a local change here when a block worth
 * having twice arrives. What is NOT acceptable is accepting the second block and letting the two share an
 * id — which is what a naive "generic blocks" feature would do.
 */
const ONE_OF_EACH = true;

/** The block kinds, in the order a signal flows — which is also the order the "add block" list shows them. */
export const BLOCK_KINDS = [
  {
    kind: 'input',
    label: 'Input',
    group: 'tone',
    blurb: 'Trim on the way in. It is what drives everything after it, so it changes the tone rather than the loudness.',
    stage: () => ampStage('gain'),
  },
  {
    kind: 'gate',
    label: 'Noise gate',
    group: 'dynamics',
    blurb: 'Silence between notes. At its lowest setting it is OFF rather than merely closed, so it is exactly transparent.',
    stage: () => ampStage('gate'),
  },
  {
    kind: 'tone',
    label: 'Tone stack',
    group: 'tone',
    blurb: 'Bass, middle and treble. One block with three controls — a tone stack is one design, and a mid separated from its bass is not a thing a tone stack can be.',
    stage: () => ({ kind: 'tone', bands: TONE_BANDS }),
  },
  {
    kind: 'model',
    label: 'Amp model',
    group: 'amp',
    needs: 'model',
    blurb: 'Your .nam, run by the engine. This is the block the others exist to feed.',
    stage: () => ({ kind: 'model' }),
  },
  {
    kind: 'cab',
    label: 'Cabinet',
    group: 'amp',
    needs: 'cab',
    blurb: 'Your speaker impulse response. Without one a modelled amp sounds like a bee in a jar.',
    stage: () => ({ kind: 'cab' }),
  },
  {
    kind: 'output',
    label: 'Output',
    group: 'level',
    // ⚠️ PINNED LAST, AND NOT AS A UI NICETY. The output level is applied on the plugin's output — after
    // both channels and after the model — so a block placed after it is processed by nothing, and an output
    // block in the middle would be a picture of something the emitted code does not do.
    pinned: 'last',
    blurb: 'Level on the way out. It cannot change how hard the model is driven — that is the input trim — which is why it is last.',
    stage: () => ampStage('level'),
  },
];

const KIND_BY_NAME = new Map(BLOCK_KINDS.map((k) => [k.kind, k]));

/** The catalogue entry for a kind, or null. */
export const blockKind = (kind) => KIND_BY_NAME.get(String(kind || '')) || null;

/** The amp chain's own stage of a kind, CLONED — so a board's block and the amp chain's cannot drift. */
function ampStage(kind) {
  const src = (AMP_CHAIN.stages || []).find((s) => s.kind === kind)
    || (PLAIN_CHAIN.stages || []).find((s) => s.kind === kind);
  if (!src) throw new Error(`board.js: no amp-chain stage of kind "${kind}"`);
  return JSON.parse(JSON.stringify(src));
}

/** The parameters a block kind contributes, with the board's saved values applied. */
function kindParams(kind, values = {}, manifest = {}) {
  const entry = blockKind(kind);
  const stage = entry ? entry.stage() : null;
  if (!stage) return [];
  const rows = stage.bands
    ? stage.bands.map((b) => ({ key: b.key, name: b.label, min: -b.rangeDb, max: b.rangeDb, def: 0, role: 'tone' }))
    : (stage.param ? [{ ...stage.param, name: stage.param.name ?? String(manifest.paramName || 'Gain') }] : []);
  return rows.map((r) => {
    // A saved value outside the range is CLAMPED rather than refused: the range can change between versions,
    // and a plugin that will not build because a saved 15 dB is now a 12 dB control is worse than one that
    // builds at 12. `validateBoard` says so.
    const v = Number(values?.[r.key]);
    return { ...r, def: Number.isFinite(v) ? Math.min(r.max, Math.max(r.min, v)) : r.def };
  });
}

/** The board an amp project gets: the amp chain, as items, with ids 1..6. */
export function ampBoard() {
  const items = (AMP_CHAIN.stages || []).map((stage, i) => {
    const kind = kindOfStage(stage);
    return { instanceId: i + 1, kind, enabled: true, values: {} };
  });
  return { nextInstanceId: items.length + 1, items };
}

/** The inverse of the catalogue's kind → stage mapping: which kind a chain stage came from. */
function kindOfStage(stage) {
  if (stage.kind === 'gain') return 'input';
  if (stage.kind === 'level') return 'output';
  return stage.kind;
}

export const DEFAULT_BOARD = ampBoard();

/** A single block, with the kind's defaults. */
export function boardItem(kind, instanceId) {
  const entry = blockKind(kind);
  if (!entry) return null;
  return { instanceId, kind: entry.kind, enabled: true, values: {} };
}

/** The next free instanceId. Monotonic and never reused, including after a block is removed. */
export function nextInstanceId(board) {
  const fromItems = (board?.items || []).reduce((m, it) => Math.max(m, Number(it.instanceId) || 0), 0);
  return Math.max(Number(board?.nextInstanceId) || 0, fromItems + 1, 1);
}

/**
 * The chain the generator emits, from the board.
 *
 * BYPASSED BLOCKS KEEP A STAGE, marked `bypass`, so that the parameter list is the same whether a block is
 * on or off — see the header. `ampChain.js` reads the mark and emits no processing; the parameter stays.
 */
export function boardChain(board, manifest = {}) {
  const stages = [];
  for (const item of board?.items || []) {
    const entry = blockKind(item.kind);
    if (!entry) continue;
    const base = entry.stage();
    const params = kindParams(item.kind, item.values, manifest);
    const stage = { ...base, id: String(item.instanceId) };
    if (params.length === 1) stage.param = { ...params[0] };
    // The tone stack is ONE block with three controls, so its saved values go back onto the table the
    // emitters read — `TONE_BANDS` — rather than onto a copy that would lose the design's frequencies.
    else if (params.length > 1) stage.bands = TONE_BANDS.map((b, i) => ({ ...b, def: params[i]?.def ?? 0 }));
    if (item.enabled === false) stage.bypass = true;
    stages.push(stage);
  }
  return { name: 'board', stages };
}

/**
 * The parameters in their STABLE identity order — the same contract as `chainParamsStable`, extended to
 * blocks the amp chain never had.
 *
 * The order is: the amp chain's known keys first, in their known order, then any other block by the ORDER IT
 * WAS ADDED (`instanceId`), never by where it currently sits. That second half is what keeps a future
 * delay's automation lane still when the board is rearranged — the trap this whole module is built around.
 */
export function boardParamsStable(board, manifest = {}) {
  const chain = boardChain(board, manifest);
  const owner = new Map();
  for (const item of board?.items || []) owner.set(String(item.instanceId), Number(item.instanceId) || 0);
  const rank = (key) => {
    const known = PARAM_ORDER.indexOf(key);
    return known < 0 ? PARAM_ORDER.length : known;
  };
  const stageOf = (key) => {
    const stage = (chain.stages || []).find((s) => {
      const keys = s.bands ? s.bands.map((b) => b.key) : (s.param ? [s.param.key] : []);
      return keys.includes(key);
    });
    return stage ? owner.get(stage.id) ?? 0 : 0;
  };
  return chainParams(chain, manifest).slice().sort((a, b) => rank(a.key) - rank(b.key) || stageOf(a.key) - stageOf(b.key));
}

// The identity order comes from `ampChain.js`'s PARAM_ORDER rather than a copy — one table, and the board's
// default arrangement must produce the amp chain's own ids. Duplicating it here is how the two would drift
// apart, and the drift would be a renumbered automation lane rather than a failing test.

/** The parameters a kind contributes, for the UI to render as controls. */
export const kindControls = (kind, manifest = {}) => kindParams(kind, {}, manifest);

/**
 * Whether a saved board can be built, and what is wrong with it if not.
 *
 * ERRORS refuse; WARNINGS do not. The split is the same one the rest of the scaffolder uses: Morpheus
 * scaffolds, so a board that is merely unwise still builds — but a board that cannot become valid C++, or
 * that would corrupt a parameter identity, has to be said out loud rather than quietly repaired, because a
 * silent repair is a user's arrangement changing without them.
 */
export function validateBoard(board, { modelFile = null, cabFile = null } = {}) {
  const errors = [];
  const warnings = [];
  const items = Array.isArray(board?.items) ? board.items : null;
  if (!items) return { ok: false, errors: ['The board has no items list.'], warnings };

  const seenIds = new Set();
  const seenKinds = new Map();
  for (const [i, item] of items.entries()) {
    const at = `block ${i + 1}`;
    const id = Number(item?.instanceId);
    if (!Number.isInteger(id) || id < 1) {
      errors.push(`${at}: instanceId must be a whole number of 1 or more — it is what identifies the block when the order changes.`);
      continue;
    }
    if (seenIds.has(id)) errors.push(`${at}: two blocks share instanceId ${id}. Every block needs its own.`);
    seenIds.add(id);

    if (!blockKind(item?.kind)) {
      errors.push(`${at}: "${item?.kind}" is not a block this version has. Add one from the list, or remove it.`);
      continue;
    }
    if (ONE_OF_EACH && seenKinds.has(item.kind)) {
      errors.push(`${at}: a second "${item.kind}" block. One of each for now — two blocks of the same kind would share their parameter ids, and that is the corruption this whole model exists to prevent.`);
      continue;
    }
    seenKinds.set(item.kind, id);

    const controls = kindControls(item.kind, {});
    for (const c of controls) {
      const v = item?.values?.[c.key];
      if (v == null) continue;
      if (!Number.isFinite(Number(v))) errors.push(`${at}: "${c.key}" is not a number.`);
      else if (Number(v) < c.min || Number(v) > c.max) warnings.push(`${at}: "${c.key}" is ${v}, outside ${c.min}..${c.max} — it will be built at the nearest end.`);
    }
  }

  const output = items.findIndex((it) => it?.kind === 'output');
  if (output < 0) {
    // Not a courtesy: the emitted loop applies the output level on the plugin's output by name, so a chain
    // without one is not a plugin this generator can write.
    errors.push('The board has no Output block. Every plugin needs one — it is the level on the way out.');
  } else if (items.some((it, i) => i > output && it?.kind)) {
    warnings.push('There are blocks after the Output block. The output level is applied on the plugin\'s output, so those blocks are processed after the level has already been set — put Output last.');
  }
  // ⚠️ THE OUTPUT LEVEL CANNOT BE BYPASSED, and it is not a limitation to work around: the emitted loop
  // multiplies by it on the plugin's output, so "bypassed" would have to mean unity gain — a different
  // plugin, and a level control that silently stopped being one. An error rather than a warning because a
  // build is the only other place this could surface.
  if (output >= 0 && items[output]?.enabled === false) {
    errors.push('The Output block cannot be bypassed. It is the level on the plugin\'s output — switch it off and there is nothing to apply.');
  }

  if (seenKinds.has('cab') && !seenKinds.has('model')) {
    warnings.push('There is a Cabinet block but no Amp model. A speaker with nothing driving it is a filter, not a cabinet.');
  }
  if (seenKinds.has('model') && !modelFile) {
    warnings.push('There is an Amp model block but no .nam in this project. Put one in the file tree (models/ is searched first) or the block does nothing.');
  }
  if (seenKinds.has('cab') && !cabFile) {
    warnings.push('There is a Cabinet block but no .wav in this project. Add one from CABINET (.wav) or the block does nothing.');
  }
  // The two files that exist but are NOT in the path — the case a user reports as "my cabinet stopped
  // working" after removing a block. The file is still baked into the plugin, so nothing looks wrong.
  if (modelFile && !seenKinds.has('model')) warnings.push(`The board has no Amp model block, so ${modelFile} is compiled into the plugin but never runs.`);
  if (cabFile && !seenKinds.has('cab')) warnings.push(`The board has no Cabinet block, so ${cabFile} is compiled into the plugin but never convolves.`);

  const bypassed = items.filter((it) => it?.enabled === false).map((it) => blockKind(it.kind)?.label || it.kind);
  if (bypassed.length) warnings.push(`Bypassed: ${bypassed.join(', ')}. A bypassed block's controls stay in the plugin — that is what keeps its automation lane pointing at it — and do nothing until it is switched back on.`);

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * The board a manifest asks for, or null.
 *
 * `null` means "this project predates the board", and the caller falls back to the `chain` field — so every
 * project that existed before this module generates exactly the plugin it generated before, byte for byte.
 * That is not sentimentality: the test bench's self-test patch, the three runner proofs and the measured
 * +5.92 dB all describe the plugin this path still produces.
 */
export function readBoard(manifest = {}) {
  const raw = manifest.board;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items) || raw.items.length === 0) return null;
  return {
    nextInstanceId: Number(raw.nextInstanceId) > 0 ? Number(raw.nextInstanceId) : nextInstanceId(raw),
    items: raw.items.map((it) => ({
      instanceId: Number(it?.instanceId),
      kind: String(it?.kind || ''),
      enabled: it?.enabled !== false,
      values: (it?.values && typeof it.values === 'object') ? { ...it.values } : {},
    })),
  };
}

/** The board as it is written back to `morpheus.plugin.json`. Normalised, so two saves of one board match. */
export function boardJson(board) {
  return {
    nextInstanceId: nextInstanceId(board),
    items: (board?.items || []).map((it) => {
      const values = {};
      for (const k of Object.keys(it.values || {}).sort()) values[k] = it.values[k];
      return { instanceId: Number(it.instanceId), kind: String(it.kind), enabled: it.enabled !== false, values };
    }),
  };
}

/** What the UI needs to draw a board: the arrangement, the catalogue, and what is wrong with it. */
export function boardView(board, { modelFile = null, cabFile = null, manifest = {} } = {}) {
  const check = validateBoard(board, { modelFile, cabFile });
  return {
    board: boardJson(board),
    blocks: (board?.items || []).map((it) => {
      const entry = blockKind(it.kind);
      return {
        instanceId: it.instanceId,
        kind: it.kind,
        label: entry?.label || it.kind,
        blurb: entry?.blurb || '',
        group: entry?.group || '',
        needs: entry?.needs || null,
        pinned: entry?.pinned || null,
        enabled: it.enabled !== false,
        controls: kindControls(it.kind, manifest).map((c) => ({
          key: c.key, name: c.name, min: c.min, max: c.max, def: c.def,
          value: Number.isFinite(Number(it.values?.[c.key])) ? Number(it.values[c.key]) : c.def,
        })),
      };
    }),
    catalogue: BLOCK_KINDS.map((k) => ({
      kind: k.kind, label: k.label, blurb: k.blurb, group: k.group,
      needs: k.needs || null, pinned: k.pinned || null,
      controls: kindControls(k.kind, manifest).map((c) => ({ key: c.key, name: c.name, min: c.min, max: c.max, def: c.def })),
    })),
    toneKeys: TONE_KEYS,
    ...check,
  };
}

/** Re-exported so a caller does not have to know that the model's position decides the two passes. */
export { chainHas, modelStageIndex };
