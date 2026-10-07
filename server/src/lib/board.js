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
//   • a SWITCHED-OFF block keeps its parameters. Bypass is a state, not an absence — dropping the parameter
//     would renumber every parameter after it, which is the same corruption wearing a different hat. (It is
//     also why `ampChain.js`'s GATE_OFF_DB is a state rather than a very low threshold.) And since the
//     blocks gained their own on/off controls, the saved `enabled` is the DEFAULT of that control rather than
//     a compile-out: the block is in the plugin either way, so a player can switch it in from the host.
//
// ── WHAT IS IN THE CATALOGUE, AND WHAT IS NOT ────────────────────────────────────────────────────────────
// The six blocks that already exist, because the loop that runs them is proven: input trim, gate, tone
// stack, the neural model, the cabinet, output level. A delay or a compressor is a NEW block kind and
// belongs in its own change — the point of a registry is that adding one is a new entry here and no change
// anywhere else, and that claim is only worth making if it is kept true.
import { AMP_CHAIN, PLAIN_CHAIN, chainHas, chainParams, isOnKey, modelStageIndex, stageOnKey } from './ampChain.js';
import { TONE_BANDS, TONE_KEYS } from './audio/toneStack.js';
import { DELAY_MARKER, DELAY_PARAMS, delayBundle } from './delayBlock.js';
import { SPRING_MARKER, SPRING_PARAMS, springBundle } from './springBlock.js';
import { DRIVE_MARKER, DRIVE_PARAMS, driveBundle } from './driveBlock.js';

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
    kind: 'delay',
    label: 'Delay',
    group: 'time',
    blurb: 'Repeats. The first block here that is not a part of an amplifier, and the one that proves the list is a list — it holds state across samples, it allocates, and it is happy anywhere in the path.',
    // A BLOCK MAY BRING ITS OWN PARAMETERS rather than borrowing an amp chain stage's. That is the difference
    // between a kind that describes an amplifier and a kind that is simply a block.
    params: () => DELAY_PARAMS.map((x) => ({ ...x })),
    marker: DELAY_MARKER,
    bundle: delayBundle,
    stage: () => ({ kind: 'delay', dsp: DELAY_MARKER }),
  },
  {
    kind: 'spring',
    label: 'Spring reverb',
    group: 'time',
    blurb: 'A tank of three springs. A click into a spring does not come out as a click — it comes out as a descending chirp, and that is what the dispersion in here is for.',
    params: () => SPRING_PARAMS.map((x) => ({ ...x })),
    marker: SPRING_MARKER,
    bundle: springBundle,
    stage: () => ({ kind: 'spring', dsp: SPRING_MARKER }),
  },
  {
    kind: 'drive',
    label: 'Drive',
    group: 'dynamics',
    blurb: 'A clean path and a clipped path summed, with the clipper biting at a guitar\u2019s own level \u2014 so the harmonics arrive under your signal rather than replacing it. Put it before the amp model.',
    params: () => DRIVE_PARAMS.map((x) => ({ ...x })),
    marker: DRIVE_MARKER,
    bundle: driveBundle,
    stage: () => ({ kind: 'drive', dsp: DRIVE_MARKER }),
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
  if (!entry) return [];
  const stage = entry.stage();
  const rows = entry.params
    ? entry.params(manifest).map((x) => ({ ...x }))
    : (stage.bands
      ? stage.bands.map((b) => ({ key: b.key, name: b.label, min: -b.rangeDb, max: b.rangeDb, def: 0, role: 'tone' }))
      : (stage.param ? [{ ...stage.param, name: stage.param.name ?? String(manifest.paramName || 'Gain') }] : []));
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

/**
 * ⭐ THE DEMO BOARD — the signal path the free download is, and the only place it is defined.
 *
 * The demo used to be `chain: 'amp'`, which is the amplifier and nothing else: four blocks, and nothing in it
 * that a pedalboard has. That was a decision about what a demo should be, and it was the wrong one — the point
 * of a demo is to be the whole thing, and the blocks that make it sound like a rig rather than a DI are the
 * ones a person would notice missing.
 *
 * ⚠️ THE ORDER IS THE MUSICAL ONE, and it is not the same as the catalogue's display order:
 *
 *   input trim → gate → DRIVE → tone stack → amp model → cabinet → DELAY → spring reverb → output
 *
 * The drive sits BEFORE the tone stack and the model, because a drive in front of an amp is what a drive is;
 * after the model it would be distorting the amp's own distortion. The delay and the spring sit AFTER the
 * cabinet, in the effects loop position, so the repeats are the sound of the amp rather than being re-amplified
 * by it. And the output is last because it is the plugin's output, not a block in the path — the catalogue pins
 * it there for exactly that reason.
 *
 * Defined here rather than in the three runner build scripts, which each had their own copy of `chain: 'amp'`
 * and would have drifted the moment one of them changed. It is data, so a guard can assert it and a build can
 * seed it without either of them owning the definition.
 */
export function demoBoard() {
  const kinds = ['input', 'gate', 'drive', 'tone', 'model', 'cab', 'delay', 'spring', 'output'];
  // ⚠️ THE PEDALS ARE IN THE PATH AND SWITCHED OFF, AND THAT IS A MEASURED DECISION RATHER THAN TASTE.
  // The blocks' own defaults are a *useful* setting for somebody who added the block on purpose (a drive at 30%
  // gain, a delay at 25% mix) and a *broken* one for a demo that claims to sound like an amplifier: out of the
  // download, every note would arrive distorted, echoing and reverberating, and the first thing anybody would
  // do is wonder why the amp sounds wrong.
  //
  // It is also what the render proof measures. `audio-nam-render-check.mjs` asserts that the plugin's output
  // nulls against the reference engine playing the same model — to -60 dB — and with the blocks' defaults that
  // check failed on the Linux runner at **-4.3 dB**, correctly: a plugin with a drive and a delay engaged is not
  // the model, and pretending otherwise would mean weakening the one proof that the plugin PLAYS what it carries.
  //
  // So: the delay and spring are mixed to nothing (their Mix at 0 is a NULL, not a quiet effect) and the drive is
  // bypassed. Turn any of them up and they are there; the download sounds like an amp.
  const values = { delay: { delay_mix: 0 }, spring: { spring_mix: 0 } };
  const off = new Set(['drive']);
  const items = kinds.map((kind, i) => {
    if (!blockKind(kind)) throw new Error(`board.js: the demo board names "${kind}", which is not a block kind`);
    return { instanceId: i + 1, kind, enabled: !off.has(kind), values: values[kind] || {} };
  });
  return { nextInstanceId: items.length + 1, items };
}

/** A single block, with the kind's defaults. */
export function boardItem(kind, instanceId) {
  const entry = blockKind(kind);
  if (!entry) return null;
  return { instanceId, kind: entry.kind, enabled: true, values: {} };
}

/** The next free instanceId. Monotonic and never reused, including after a block is removed. */
export function nextInstanceId(board) {
  // ⚠️ `it?.instanceId`, NOT `it.instanceId`. This runs on the RAW body of a save, before validation, so a
  // malformed item is an ordinary thing to receive — and `JSON.stringify` turns a sparse array's holes into
  // `null`. Reading through the hole threw, and the route answered 500 to what is a 400.
  const fromItems = (board?.items || []).reduce((m, it) => Math.max(m, Number(it?.instanceId) || 0), 0);
  return Math.max(Number(board?.nextInstanceId) || 0, fromItems + 1, 1);
}

/**
 * The chain the generator emits, from the board.
 *
 * A SWITCHED-OFF BLOCK KEEPS A STAGE, marked `bypass`, so that the parameter list is the same whether a block
 * is on or off — see the header. `bypass` is the block's DEFAULT now rather than its fate: `ampChain.js`
 * emits the block's DSP either way, wrapped in the crossfade its own `on_<kind>` control drives, and the
 * mark only decides which end of that control the plugin opens on. `verify-audio-plugin.mjs` asserts the
 * demo's default patch is still a null for exactly this reason.
 */
export function boardChain(board, manifest = {}) {
  const stages = [];
  for (const item of board?.items || []) {
    const entry = blockKind(item.kind);
    if (!entry) continue;
    const base = entry.stage();
    const params = kindParams(item.kind, item.values, manifest);
    const stage = { ...base, id: String(item.instanceId) };
    // A block that brings its own DSP says so with a marker; `ampChain.js` passes it through untouched.
    if (entry.marker) stage.dsp = entry.marker;
    // ⚠️ AND A BLOCK THAT BRINGS ITS OWN PARAMETERS CARRIES THEM ON THE STAGE. The branch below used to read
    // "more than one parameter means a tone stack", which was true while the tone stack was the only block
    // with three controls and became a SILENT CORRUPTION the moment a delay arrived: the delay's Time,
    // Feedback and Mix were written over `TONE_BANDS` as though they were bass, middle and treble, so the
    // generated plugin had BASS = 300 ms and no delay in it at all. A kind that declares a table gets that
    // table; the tone stack's three controls stay the one design the emitters read from `TONE_BANDS`.
    if (entry.params) stage.params = params;
    else if (params.length === 1) stage.param = { ...params[0] };
    else if (stage.bands) stage.bands = TONE_BANDS.map((b, i) => ({ ...b, def: params[i]?.def ?? 0 }));
    if (item.enabled === false) stage.bypass = true;
    stages.push(stage);
  }
  return { name: 'board', stages };
}

/**
 * The parameters in their STABLE identity order — the same contract as `chainParamsStable`, extended to
 * blocks the amp chain never had.
 *
 * ⭐ THE ORDER IS CREATION, NOT ARRANGEMENT, AND NOT A FIXED LIST OF KNOWN KEYS.
 *
 * Keyed by the owning item's `instanceId`, which is assigned once and never reused, so:
 *   • dragging a block does not move a control — the id a host automated still belongs to it;
 *   • ADDING a block does not move an existing control either, whatever kind it is. A fixed order of known
 *     keys would fail that the moment a new kind sorted into the middle of it: the delay's controls would be
 *     renumbered by a tone stack added afterwards, which is the same corruption wearing a different hat.
 *
 * The amp chain's own ids come out unchanged, and not by luck: `ampBoard()` numbers the amp chain's stages
 * in their signal order, so creation order IS `PARAM_ORDER` for the board every amp project opens with —
 * which is what makes the default board generate the amp chain byte for byte.
 */
export function boardParamsStable(board, manifest = {}) {
  const chain = boardChain(board, manifest);
  const owner = new Map();
  for (const item of board?.items || []) owner.set(String(item.instanceId), Number(item.instanceId) || 0);
  const ownerOf = (key) => {
    const stage = (chain.stages || []).find((st) => {
      // All THREE shapes a stage can hold its controls in. Missing `params` here is not a cosmetic bug: a
      // key whose owner cannot be found is ranked 0, which sorts it to the FRONT of the parameter list — so
      // the delay's controls landed before Input and every id in the amp chain moved by three.
      const keys = st.params ? st.params.map((x) => x.key)
        : (st.bands ? st.bands.map((b) => b.key) : (st.param ? [st.param.key] : []));
      // ⚠️ AND THE BLOCK'S SWITCH BELONGS TO THE SAME BLOCK. It is not in any of those lists — it is
      // synthesised by `chainParams` — so without this it has no owner, ranks 0, and a board reorder would
      // move it. Which is exactly what happened: reversing the board reversed the switches' ids.
      return keys.includes(key) || stageOnKey(st) === key;
    });
    return stage ? owner.get(stage.id) ?? 0 : 0;
  };
  // A stable sort, so the parameters WITHIN one block keep the order that block declares — Time, Feedback,
  // Mix is the order the panel shows and the order the host will list.
  //
  // ⚠️ THE BLOCKS' SWITCHES SORT AFTER EVERY CONTROL, exactly where `chainParams` appends them and where
  // `chainParamsStable` puts them (see `PARAM_ORDER`). `paramsCpp` derives a parameter's id from its
  // POSITION, so a switch that sorted in beside its block would renumber every control after it — and the
  // default board would stop generating the amp chain byte for byte. The panel groups each switch back with
  // its block for display; it addresses them by id, so nothing is lost by having them last in the host's list.
  //
  // ⚠️ AND THEY ARE STILL RANKED BY THEIR OWN BLOCK, not left in whatever order the stage list happens to be
  // in. Two separate keys order this list: controls before switches, and within each group the block's
  // creation order. Both are needed — the first keeps every existing id where it was, and the second is what
  // makes reversing the board leave the switches un-moved too.
  return chainParams(chain, manifest).slice().sort((a, b) => {
    const as = isOnKey(a.key) ? 1 : 0;
    const bs = isOnKey(b.key) ? 1 : 0;
    if (as !== bs) return as - bs;
    return ownerOf(a.key) - ownerOf(b.key);
  });
}

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
  if (bypassed.length) warnings.push(`Switched off by default: ${bypassed.join(', ')}. The block is still in the plugin — its controls keep their ids, so a host's automation lane still points at them — and its own On/Off control starts at Off, so it can be switched on from the plugin without a rebuild.`);

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

/**
 * Everything the board's blocks contribute to the generated plugin that is not a parameter: file-scope DSP,
 * state inside `plugin_t`, and the alloc/free pair.
 *
 * The template is handed this and knows nothing else about a delay — see `pluginSource`'s `blocks` argument.
 * Deduped by marker, because two blocks of one kind are refused today but a bundle that emitted the same
 * struct twice would be a compile error rather than a validation message.
 */
export function boardBundle(board) {
  const out = { dsp: [], state: [], init: [], destroy: [], markers: {} };
  const seen = new Set();
  for (const item of board?.items || []) {
    const entry = blockKind(item.kind);
    if (!entry || !entry.bundle || seen.has(item.kind)) continue;
    seen.add(item.kind);
    const b = entry.bundle();
    if (b.dsp) out.dsp.push(b.dsp);
    if (b.state) out.state.push(b.state);
    if (b.init) out.init.push(b.init);
    if (b.destroy) out.destroy.push(b.destroy);
    Object.assign(out.markers, b.markers || {});
  }
  return {
    dsp: out.dsp.join('\n'),
    state: out.state.join('\n'),
    init: out.init.join('\n'),
    destroy: out.destroy.join('\n'),
    markers: out.markers,
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
