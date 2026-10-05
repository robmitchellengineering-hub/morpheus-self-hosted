// The amp chain: what a plugin's parameters ARE, and the C++ that puts them in the signal path.
//
// WHY THIS IS A MODULE RATHER THAN TEXT INSIDE THE TEMPLATE. `audioPluginTemplate.js` holds the plugin's
// source, and the chain is the one part of it that is a TABLE — parameters with ids, names, ranges and
// roles — and tables are what drift: a parameter that exists in the host's list and not in the process loop,
// or a tone band whose corner frequency is right in the measurement and wrong in the build. Both the C++ and
// `scripts/audio-amp-chain-check.mjs` read this one table.
//
// ── THE PLAIN PLUGIN IS NOT A DEGRADED AMP, IT IS A DIFFERENT PLUGIN ─────────────────────────────────────
// Every project that existed before this module still generates the single-`Gain` plugin, byte for byte, and
// that is the point: the test bench's self-test patch, the three runner proofs and the measured +5.92 dB all
// describe that plugin, and a chain that turned itself on would silently invalidate every one of them. A
// project opts in through `morpheus.plugin.json`.
import { TONE_BANDS, TONE_KEYS } from './audio/toneStack.js';

/**
 * The gate's threshold at its lowest setting, in dB — and at that value the gate is BYPASSED rather than
 * merely permissive. See the parameter's own note.
 */
export const GATE_OFF_DB = -80;

/**
 * A CHAIN IS DATA — an ordered list of STAGES, each with a stable `id`.
 *
 * ⚠️ THE `id` IS NOT DECORATION AND IT IS NOT THE POSITION. Every stage carries one so that identity survives
 * a reorder, which is the single decision that is painful to retrofit: anything keyed by position (a saved
 * parameter value, a MIDI binding, an automation lane in a host) silently follows the wrong block the moment
 * a user drags one past another. The pedalboard work reads `instanceId` out of PiPedal's model for exactly
 * this reason, and it is cheaper to have it here before there is anything to break.
 *
 * `kind` is what a stage DOES; `role` is which parameter drives it. The emitters ask two questions of this
 * list — is there a stage of this kind, and where is the model — instead of branching on a chain's name.
 */
export const chainHas = (chain, kind) => (chain.stages || []).some((s) => s.kind === kind);

/**
 * WHERE THE MODEL SITS, so the pre-model/post-model split is DERIVED rather than assumed.
 *
 * The split exists because the model runs a whole block at once — `process()` once per chunk instead of once
 * per sample, which was 2.6x of this plugin's entire real-time budget. That optimisation is an AMP's shape: a
 * chain with no model has no middle, and a chain that is only a delay has nothing either side of it. Asking
 * the list where the model is means the next chain does not have to be an amp to be expressed.
 */
export const modelStageIndex = (chain) => (chain.stages || []).findIndex((s) => s.kind === 'model');

/** The single-parameter plugin every project got before the chain existed. */
export const PLAIN_CHAIN = {
  name: 'plain',
  stages: [
    // `name: null` — the plain plugin's one control is called `Gain` by default, and is renamed from the
    // manifest. The amp's output stage names itself, which is the only difference between the two.
    { id: 'output', kind: 'level', role: 'output', param: { key: 'output', name: null, min: -60, max: 12, def: 0, role: 'output' } },
  ],
};

/**
 * The amp chain: input trim, a noise gate, a three-band tone stack, the model (when there is one), the
 * cabinet (when there is one), output level.
 *
 * ORDER MATTERS AND IT IS THE MUSICAL ONE. Input trim first because it is what drives everything after it; the
 * GATE next, before anything that amplifies, because a gate after the tone stack or the model is gating the
 * noise they added; the tone stack on the way in; the model in the middle because everything else exists to
 * feed it and to tame what comes out; the cabinet after the model because a speaker is part of the amp; output
 * last so the level control cannot change how the model distorts — the difference between a level control and
 * a drive control, and the reason a player expects turning the output down to sound identical, only quieter.
 */
export const AMP_CHAIN = {
  name: 'amp',
  // IN SIGNAL ORDER, which is the only order this list may be in: the loop walks it. The musical reasoning
  // for that order is above and is unchanged by the shape.
  stages: [
    { id: 'input', kind: 'gain', role: 'input',
      param: { key: 'input', name: 'Input', min: -24, max: 24, def: 0, role: 'input' } },
    // ⚠️ THE BOTTOM OF THE RANGE IS OFF, NOT A VERY LOW THRESHOLD, and the difference is measurable: at -80 dB
    // the gate is still an envelope follower on the signal and never exactly transparent, while OFF is a null
    // against the chain without a gate at all. That is the state the proof asserts, so it has to be a state.
    { id: 'gate', kind: 'gate', role: 'gate',
      param: { key: 'gate', name: 'Gate', min: GATE_OFF_DB, max: 0, def: GATE_OFF_DB, role: 'gate' } },
    // The three bands are ONE stage with three parameters: they are one design — a tone stack — and pulling
    // them apart into three stages would let a reorder separate a mid from its bass, which is not a thing a
    // tone stack can be.
    { id: 'tone', kind: 'tone', bands: TONE_BANDS },
    { id: 'model', kind: 'model' },
    { id: 'cab', kind: 'cab' },
    { id: 'output', kind: 'level', role: 'output',
      param: { key: 'output', name: 'Output', min: -60, max: 12, def: 0, role: 'output' } },
  ],
};

/**
 * Which chain this project asked for.
 *
 * `morpheus.plugin.json`'s `chain` field names it. An unknown value is NOT an error and does not silently
 * become the amp: a project that asked for something this version does not have gets the plugin it would have
 * got before the field existed, and `readManifest` reports the value so the scaffold can warn about it.
 */
export function chainFor(manifest = {}) {
  const asked = String(manifest.chain || '').trim().toLowerCase();
  if (asked === 'amp') return AMP_CHAIN;
  return PLAIN_CHAIN;
}

/**
 * The parameter list, DERIVED from the stages — read in the stages' order, which is the order the emitted
 * `IDX_*` constants and the host's automation lanes are in.
 *
 * KEYED `output` IN BOTH CHAINS, deliberately and unchanged: the emitted C++ indexes the parameters by key,
 * and the final multiply is written on `IDX_OUTPUT` either way — so the test bench's patch, which proves its
 * own checks can fail by breaking that one line, has a single shape to match.
 */
export function chainParams(chain, manifest = {}) {
  const out = [];
  for (const stage of chain.stages || []) {
    if (stage.bands) out.push(...stage.bands.map((b) => ({ key: b.key, name: b.label, min: -b.rangeDb, max: b.rangeDb, def: 0, role: 'tone' })));
    else if (stage.param) out.push({ ...stage.param, name: stage.param.name ?? String(manifest.paramName || 'Gain') });
  }
  return out;
}

const cstr = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const num = (v) => {
  const s = String(Number(v));
  return s.includes('.') || s.includes('e') ? s : `${s}.0`;
};

// ── the noise gate ──────────────────────────────────────────────────────────────────────────────────────
// WHY A GATE IS THE FIRST THING AFTER THE TRIM, and not later: a gate placed after the tone stack or the model
// is gating the noise THEY added rather than the noise that came in, and it cannot un-add what they did. This
// one sees what the player's instrument and cable actually sent.
//
// THE OTHER THREE NUMBERS ARE FIXED, and that is a decision rather than an omission: a 1 ms attack, a 120 ms
// release and 6 dB of hysteresis are not musical choices at this stage, and a gate with four controls is a
// gate nobody sets. The threshold is the one a player reaches for.

/** The gate's DSP, emitted when the chain has a gate. */
export const gateDspCpp = `// ── the noise gate ───────────────────────────────────────────────────────────────────────────────────
// An envelope follower and a switch with hysteresis. See lib/ampChain.js for why the time constants are not
// parameters.
typedef struct { double env; double gain; int open; } gate_t;

#define MORPHEUS_GATE_ATTACK_MS 1.0
#define MORPHEUS_GATE_RELEASE_MS 120.0
// HALF THE THRESHOLD IS -6 dB: a signal sitting exactly at the threshold would otherwise open and close the
// gate on alternate samples, which is audible as a buzz rather than as a gate.
#define MORPHEUS_GATE_HYSTERESIS 0.5

static double gate_process(gate_t *g, double x, double threshold_db, double fs) {
   const double rectified = fabs(x);
   const double atk = exp(-1.0 / (MORPHEUS_GATE_ATTACK_MS * 0.001 * fs));
   const double rel = exp(-1.0 / (MORPHEUS_GATE_RELEASE_MS * 0.001 * fs));
   g->env = rectified > g->env ? atk * g->env + (1.0 - atk) * rectified
                               : rel * g->env + (1.0 - rel) * rectified;
   const double thr = pow(10.0, threshold_db / 20.0);
   if (g->env > thr) g->open = 1;
   else if (g->env < thr * MORPHEUS_GATE_HYSTERESIS) g->open = 0;
   // The gain moves on the SAME two time constants, so the gate opens fast and closes gently. A gate's click
   // is the gain moving in one sample, which is the entire reason these constants exist.
   const double c = g->open ? atk : rel;
   g->gain += ((g->open ? 1.0 : 0.0) - g->gain) * (1.0 - c);
   return x * g->gain;
}`;

/** The gate's per-instance state. Per channel, like everything else that holds a signal's history. */
export const gateStateCpp = `   gate_t gate[2];`;

/** Start the gate open, so a plugin that is never told a threshold does not fade in. */
export const gateInitCpp = `   for (int c = 0; c < 2; ++c) { p->gate[c].env = 0.0; p->gate[c].gain = 1.0; p->gate[c].open = 1; }`;

/** The stage, per channel. */
export const gateStageCpp = `         // ⚠️ THE BOTTOM OF THE RANGE IS OFF, and bypassed rather than merely permissive: at -80 dB the
         // gate is still an envelope follower and never exactly transparent, while OFF nulls against the
         // chain without a gate — which is the state the measurement asserts.
         if (p->smoothed[IDX_GATE] > (double)MORPHEUS_GATE_OFF_DB + 0.001) {
            x = gate_process(&p->gate[c], x, p->smoothed[IDX_GATE], p->fs);
         }`;

/** The parameter array index of a role, or -1. Used by the emitted C++ and by the measurement. */
export const paramIndex = (params, key) => params.findIndex((p) => p.key === key);

// ── the emitted C++ ──────────────────────────────────────────────────────────────────────────────────────
// Every fragment below is C++ text for the generated plugin. They are functions rather than constants
// because each one is shaped by the parameter table.

/** The id enum and the table the params extension reads. */
export function paramsCpp(params) {
  const enums = params.map((p, i) => `PARAM_${p.key.toUpperCase()} = ${i + 1}`).join(', ');
  const rows = params
    .map((p, i) => `   { ${i + 1}, ${cstr(p.name)}, ${num(p.min)}, ${num(p.max)}, ${num(p.def)} },`)
    .join('\n');
  return `// The id must not be 0: CLAP_INVALID_ID means "no parameter", so a host treats an event carrying id 0 as
// malformed. These come from server/src/lib/ampChain.js — one table, used here and by the measurement.
enum { ${enums} };
#define MORPHEUS_NUM_PARAMS ${params.length}

// The array index of each parameter, named, so the process loop cannot index the wrong one.
${params.map((p, i) => `#define IDX_${p.key.toUpperCase()} ${i}`).join('\n')}

static const struct { clap_id id; const char *name; double min; double max; double def; } kParams[] = {
${rows}
};`;
}

/** The per-instance state: one value and one smoothed value per parameter, plus the filter state. */
export function stateCpp(chain, params) {
  const lines = [
    '   // One pair per parameter, indexed by IDX_*, and stepped one sample at a time. Keeping the host value',
    '   // and the applied value apart is what stops a parameter jump from clicking.',
    `   double value[MORPHEUS_NUM_PARAMS];`,
    `   double smoothed[MORPHEUS_NUM_PARAMS];`,
    '   double fs;',
  ];
  if (chainHas(chain, 'tone')) {
    lines.push(
      '',
      '   // One filter per band per channel: a stereo plugin needs its state twice or the two channels bleed',
      '   // into each other, which is audible as a widening image rather than as an error.',
      `   biquad_t tone[2][${TONE_KEYS.length}];`,
      `   double tone_last[${TONE_KEYS.length}];`,
    );
  }
  if (params.some((p) => p.role === 'gate')) lines.push(gateStateCpp);
  return lines.join('\n');
}

/** Set every parameter to its default, in init(). */
export function initCpp(params) {
  return params
    .map((p, i) => `   p->value[${i}] = ${num(p.def)}; p->smoothed[${i}] = ${num(p.def)};`)
    .join('\n');
}

/** Which index an incoming event addresses, by id. */
export function eventCpp() {
  return [
    '   if (hdr->space_id != CLAP_CORE_EVENT_SPACE_ID || hdr->type != CLAP_EVENT_PARAM_VALUE) return;',
    '   const clap_event_param_value_t *ev = (const clap_event_param_value_t *)hdr;',
    '   int ix = -1;',
    '   for (uint32_t i = 0; i < MORPHEUS_NUM_PARAMS; ++i) if (kParams[i].id == ev->param_id) { ix = (int)i; break; }',
    '   if (ix < 0) return;',
    '   const double v = ev->value;',
    '   p->value[ix] = v < kParams[ix].min ? kParams[ix].min : (v > kParams[ix].max ? kParams[ix].max : v);',
  ].join('\n');
}

/**
 * The biquad and the tone stack, when this chain has one.
 *
 * DIRECT FORM 1, AND THE SAME STATEMENT ORDER AS `lib/audio/dsp.js`'s `biquadProcess` — deliberately. The
 * measurement compares the plugin's response against that implementation's, and two forms of the same filter
 * differ in the last bits: matching the form makes any difference the measurement finds a real one rather
 * than arithmetic bookkeeping.
 */
export function toneCpp() {
  return `// ── the tone stack ───────────────────────────────────────────────────────────────────────────────────
// Three biquads whose corner frequencies and Q values are generated from server/src/lib/audio/toneStack.js,
// so the design the measurement is checked against and the filters that run are the same numbers.
typedef struct { double b0, b1, b2, a1, a2; double x1, x2, y1, y2; } biquad_t;

static double biquad_process(biquad_t *q, double x0) {
   const double out = q->b0 * x0 + q->b1 * q->x1 + q->b2 * q->x2 - q->a1 * q->y1 - q->a2 * q->y2;
   q->x2 = q->x1; q->x1 = x0; q->y2 = q->y1; q->y1 = out;
   return out;
}

enum { TONE_LOWSHELF = 0, TONE_PEAK = 1, TONE_HIGHSHELF = 2 };

// WHEN THE COEFFICIENTS ARE RECOMPUTED. Recomputing them every sample costs six sin/cos/pow calls on the
// audio thread for nothing once a control has settled; recomputing them only when the value has moved by a
// LOT leaves the filter slightly wrong forever, and that error is visible in a null test against the design
// (0.001 dB of coefficient error measured as -55 dB of residual, which is how this number was chosen).
// A millionth of a dB is far below audibility and far above double-precision noise, and once a parameter
// stops moving the comparison is false and no work happens at all.
#define MORPHEUS_TONE_EPS 0.000001

// The RBJ cookbook, which is what lib/audio/dsp.js implements too. Every branch is normalised by a0 so the
// difference equation above needs no division per sample.
static void biquad_set(biquad_t *q, int type, double freq, double qq, double gain_db, double fs) {
   const double w0 = 2.0 * 3.14159265358979323846 * freq / fs;
   const double cw = cos(w0);
   const double sw = sin(w0);
   const double alpha = sw / (2.0 * qq);
   const double A = pow(10.0, gain_db / 40.0);
   double b0, b1, b2, a0, a1, a2;
   if (type == TONE_LOWSHELF) {
      const double s = 2.0 * sqrt(A) * alpha;
      b0 = A * ((A + 1.0) - (A - 1.0) * cw + s);
      b1 = 2.0 * A * ((A - 1.0) - (A + 1.0) * cw);
      b2 = A * ((A + 1.0) - (A - 1.0) * cw - s);
      a0 = (A + 1.0) + (A - 1.0) * cw + s;
      a1 = -2.0 * ((A - 1.0) + (A + 1.0) * cw);
      a2 = (A + 1.0) + (A - 1.0) * cw - s;
   } else if (type == TONE_PEAK) {
      b0 = 1.0 + alpha * A; b1 = -2.0 * cw; b2 = 1.0 - alpha * A;
      a0 = 1.0 + alpha / A; a1 = -2.0 * cw; a2 = 1.0 - alpha / A;
   } else {
      const double s = 2.0 * sqrt(A) * alpha;
      b0 = A * ((A + 1.0) + (A - 1.0) * cw + s);
      b1 = -2.0 * A * ((A - 1.0) + (A + 1.0) * cw);
      b2 = A * ((A + 1.0) + (A - 1.0) * cw - s);
      a0 = (A + 1.0) - (A - 1.0) * cw + s;
      a1 = 2.0 * ((A - 1.0) - (A + 1.0) * cw);
      a2 = (A + 1.0) - (A - 1.0) * cw - s;
   }
   q->b0 = b0 / a0; q->b1 = b1 / a0; q->b2 = b2 / a0; q->a1 = a1 / a0; q->a2 = a2 / a0;
}`;
}

/** Recompute the coefficients when a band's smoothed gain has moved, and process one band per channel. */
export function toneUpdateCpp() {
  return TONE_BANDS.map((b, i) => [
    `   if (fabs(p->smoothed[IDX_${b.key.toUpperCase()}] - p->tone_last[${i}]) > MORPHEUS_TONE_EPS) {`,
    `      p->tone_last[${i}] = p->smoothed[IDX_${b.key.toUpperCase()}];`,
    `      for (int c = 0; c < 2; ++c) biquad_set(&p->tone[c][${i}], ${toneTypeConst(b.type)}, ${num(b.freq)}, ${num(b.q)}, p->tone_last[${i}], p->fs);`,
    '   }',
  ].join('\n')).join('\n');
}

const toneTypeConst = (type) => ({ lowshelf: 'TONE_LOWSHELF', peak: 'TONE_PEAK', highshelf: 'TONE_HIGHSHELF' }[type]);

/**
 * The chain, per sample, for one channel. `x` is the sample; the result replaces it.
 *
 * ⚠️ THE OUTPUT LEVEL IS NOT HERE, and it was, which applied it twice: this emitted the output-role multiply
 * inside the channel loop and the process loop's final line applied the output level again, so a +6 dB
 * setting measured +11.85 dB. The test bench caught it on the first local run — "setting Gain changes the
 * level by the amount it says — measured 11.85 dB, expected 6.00 dB" — which is what that check is for.
 * The output level stays on the final line, after both channels, because it is a level on the plugin's
 * output rather than a stage inside one channel's path.
 */
export function chainPreCpp(chain, params) {
  const lines = [];
  const stages = chain.stages || [];
  const at = modelStageIndex(chain);
  // EVERY STAGE BEFORE THE MODEL, in the order the chain declares — not in parameter order, and not by
  // asking each parameter what it is. Same list, same order, same output; the difference is that the next
  // chain does not have to be an amp for this to make sense.
  for (const stage of stages.slice(0, at < 0 ? stages.length : at)) {
    if (stage.kind === 'gain') {
      const p = params.find((x) => x.role === 'input');
      if (p) lines.push(`         x *= db_to_linear(p->smoothed[IDX_${p.key.toUpperCase()}]);`);
    } else if (stage.kind === 'gate') {
      // The gate runs on the channel's sample before anything that amplifies it.
      lines.push('__GATE_STAGE__');
    } else if (stage.kind === 'tone') {
      for (const b of TONE_BANDS) lines.push(`         x = biquad_process(&p->tone[c][${TONE_KEYS.indexOf(b.key)}], x);`);
    }
  }
  return lines.join('\n');
}

/**
 * The stages AFTER the model. The cabinet is the only one, and it is last of the three because a speaker is
 * driven by the amp: convolving before the model would put a cabinet in front of the amplifier.
 *
 * ⚠️ THE MODEL USED TO BE EMITTED HERE TOO, AND IT IS NOT ANY MORE. It sat between the tone stack and the
 * cabinet as an inline `#if MORPHEUS_HAS_MODEL` block, which was the right PLACE and the wrong SHAPE: it ran
 * one sample at a time, inside a per-sample loop, per channel. Splitting the chain here is what lets the
 * template call the engine once per block instead of once per sample — see audioPluginTemplate.js, which
 * owns that loop and the measurement behind it.
 */
export function chainPostCpp(chain) {
  // STILL EMITTED UNCONDITIONALLY, AND THAT IS DELIBERATE. The cabinet's own text is behind
  // `#if MORPHEUS_HAS_CAB`, so a chain without one compiles this away; making it conditional HERE would
  // change the generated source for the plain chain, and a refactor that changes the output is not a
  // refactor. Where it SITS is now the stages' business — after the model — and that is the part that had to
  // stop being an assumption.
  void chain;
  return '__CAB_STAGE__';
}

/** Every parameter stepped one sample toward its target. */
export function smoothCpp(skipIdx = null) {
  return [
    '         for (uint32_t k = 0; k < MORPHEUS_NUM_PARAMS; ++k) {',
    ...(skipIdx ? [`            if (k == ${skipIdx}) continue;`] : []),
    '            p->smoothed[k] += (p->value[k] - p->smoothed[k]) * 0.001;',
    '         }',
  ].join('\n');
}

/**
 * ONE parameter stepped one sample toward its target, for the parameter that has to keep its own ramp.
 *
 * WHY THIS EXISTS. The output level is applied AFTER the model, and the model now runs a whole block at a
 * time — so the output smoother would otherwise be stepped in the first pass, run a block ahead, and apply
 * a block-early value to every sample in it. That is 1.3 ms of ramp at 64 frames: inaudible, and still a
 * difference nobody asked for, so the output ramp is stepped where the output is, and the first pass
 * deliberately skips it.
 */
export function smoothOneCpp(idxName) {
  return `         p->smoothed[${idxName}] += (p->value[${idxName}] - p->smoothed[${idxName}]) * 0.001;`;
}
