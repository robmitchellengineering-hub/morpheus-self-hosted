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

/** The single-parameter plugin every project got before the chain existed. */
export const PLAIN_CHAIN = { name: 'plain', params: null, tone: false };

/**
 * The amp chain: input trim, a three-band tone stack, the model (when there is one), output level.
 *
 * ORDER MATTERS AND IT IS THE MUSICAL ONE. Input trim before the tone stack because the trim is what drives
 * the model and the tone stack is a filter on the way in; the model in the middle because everything else
 * exists to feed it and to tame what comes out; output last so the level control cannot change how the model
 * distorts — which is the difference between a level control and a drive control, and the reason a player
 * expects turning the output down to sound identical, only quieter.
 */
export const AMP_CHAIN = {
  name: 'amp',
  tone: true,
  params: [
    { key: 'input', name: 'Input', min: -24, max: 24, def: 0, role: 'input' },
    ...TONE_BANDS.map((b) => ({ key: b.key, name: b.label, min: -b.rangeDb, max: b.rangeDb, def: 0, role: 'tone' })),
    { key: 'output', name: 'Output', min: -60, max: 12, def: 0, role: 'output' },
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

/** The parameter list, with the plain plugin's single Gain named from the manifest. */
export function chainParams(chain, manifest = {}) {
  if (chain.params) return chain.params;
  // KEYED `output` IN BOTH CHAINS, deliberately: the emitted C++ indexes the parameters by key, and the
  // final multiply is written on `IDX_OUTPUT` either way — so the test bench's patch, which proves its own
  // checks can fail by breaking that one line, has a single shape to match.
  return [{ key: 'output', name: String(manifest.paramName || 'Gain'), min: -60, max: 12, def: 0, role: 'output' }];
}

const cstr = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const num = (v) => {
  const s = String(Number(v));
  return s.includes('.') || s.includes('e') ? s : `${s}.0`;
};

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
  if (chain.tone) {
    lines.push(
      '',
      '   // One filter per band per channel: a stereo plugin needs its state twice or the two channels bleed',
      '   // into each other, which is audible as a widening image rather than as an error.',
      `   biquad_t tone[2][${TONE_KEYS.length}];`,
      `   double tone_last[${TONE_KEYS.length}];`,
    );
  }
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
export function chainSampleCpp(chain, params) {
  const lines = [];
  for (const p of params) {
    if (p.role === 'input') lines.push(`         x *= db_to_linear(p->smoothed[IDX_${p.key.toUpperCase()}]);`);
  }
  if (chain.tone) {
    for (const b of TONE_BANDS) lines.push(`         x = biquad_process(&p->tone[c][${TONE_KEYS.indexOf(b.key)}], x);`);
  }
  // ALWAYS EMITTED, BEHIND THE FLAG. The plugin source is the same text with a model and without one — see
  // namPlugin.js on why that matters to the test bench — so the model sits in the chain as a guarded block
  // rather than as something the generator decides to include.
  // THE CABINET GOES HERE, between the model and the level — the speaker is part of the amp, and a cabinet
  // after a level control would change its tone when the level moved. `cabStageCpp` is emitted by cabIr.js,
  // which is the module that knows what a cabinet is.
  lines.push('__CAB_STAGE__');
  lines.push(
    '#if MORPHEUS_HAS_MODEL',
    '         // The model is the amp: its output replaces the dry sample. Reset() sized its buffers and',
    '         // settled its initial conditions in activate(); nothing here allocates.',
    '         if (p->model[c]) {',
    '            NAM_SAMPLE mx[1] = {(NAM_SAMPLE)x};',
    '            NAM_SAMPLE my[1] = {0};',
    '            NAM_SAMPLE *mip[1] = {mx};',
    '            NAM_SAMPLE *mop[1] = {my};',
    '            p->model[c]->process(mip, mop, 1);',
    '            x = (double)my[0];',
    '         }',
    '#endif',
  );
  return lines.join('\n');
}

/** Every parameter stepped one sample toward its target. */
export function smoothCpp() {
  return [
    '         for (uint32_t k = 0; k < MORPHEUS_NUM_PARAMS; ++k) {',
    '            p->smoothed[k] += (p->value[k] - p->smoothed[k]) * 0.001;',
    '         }',
  ].join('\n');
}
