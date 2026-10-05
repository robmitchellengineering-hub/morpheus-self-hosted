// Bake a cabinet impulse response into the generated plugin.
//
// WHY A CABINET IS NOT OPTIONAL FOR AN AMP. A `.nam` is usually the AMP — the circuit, the valves, the
// speaker's electrical load. What makes it sound like a recording rather than a bee in a jar is the SPEAKER,
// and that is a convolution. An amp model with no cab is the thing people mean when they say a modeller
// sounds "fizzy"; it is also the half of the chain the model cannot supply, because the speaker is linear and
// the amp is not.
//
// ── THE SAME SHAPE AS THE MODEL, DELIBERATELY ────────────────────────────────────────────────────────────
// `lib/namPlugin.js` finds a `.nam`, checks it, and emits the bytes as C++ so the plugin needs no parser and
// no runtime file loading. This does exactly that for a `.wav`: **decoded in JavaScript, where the project
// already has a guarded WAV reader**, and emitted as float coefficients. The plugin never sees a RIFF header.
// Two features with the same shape are two features someone can learn once.
//
// ── WHAT IS NOT HIDDEN: THE NORMALISATION ────────────────────────────────────────────────────────────────
// Impulse responses arrive at wildly different levels, so the taps are normalised to a PEAK OF 1.0 at bake
// time and the original peak is recorded in the header. A level change that nobody wrote down is the kind of
// thing that gets discovered six months later as "the cabinet sounds quieter than the amp"; this one is in
// the header, in the proof file, and in the manual.
import { decodeWav } from './audio/wav.js';

/** Where a cabinet usually lives. Not required: any `.wav` in the project will do. */
export const CAB_DIR = 'models';

/** The generated pair, mirroring the model's. */
export const CAB_DATA_SOURCE = 'Source/CabIr.cpp';
export const CAB_DATA_HEADER = 'Source/CabIr.h';

/**
 * THE LONGEST IR THIS BUILD WILL CONVOLVE DIRECTLY, in samples.
 *
 * 4096 is ~85 ms at 48 kHz, which is longer than almost every speaker IR's useful tail and shorter than the
 * ones that are mostly room. Direct convolution costs one multiply per tap per sample per channel, so this
 * cap is the difference between a plugin a Raspberry Pi can run and one it cannot — and it is a CAP rather
 * than a truncation without a word: a longer file is truncated and the fact is recorded in the header, the
 * proof file, and the scaffold's warnings. FFT partitioning is the way past it and is not built yet.
 */
export const MAX_CAB_TAPS = 4096;

const hasCab = (files, path) => (Array.isArray(files) ? files : [])
  .some((f) => f && f.path === path && f.content !== undefined);

/** The IR this project carries, or null. Named in the manifest, or found the way the model is. */
export function findCabPath(files, manifest = {}) {
  const named = typeof manifest.cab === 'string' ? manifest.cab.trim() : '';
  if (named) return hasCab(files, named) ? named : null;

  const candidates = (Array.isArray(files) ? files : [])
    .filter((f) => f && typeof f.path === 'string' && /\.wav$/i.test(f.path))
    .map((f) => f.path)
    .sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  return candidates[0] || null;
}

function rank(path) {
  const depth = path.split('/').length;
  return (/^models\//i.test(path) ? 0 : 100) + depth;
}

/**
 * Decode an IR from a file the project holds.
 *
 * The input is base64 or a raw string depending on how the project stores a binary — the same problem the
 * model's text avoids by being JSON. So this accepts either and says which it got, rather than guessing: a
 * mis-decoded IR is a very quiet, very wrong cabinet.
 */
export function decodeCab(content, encoding = 'base64') {
  const buf = Buffer.isBuffer(content) ? content
    : Buffer.from(String(content), encoding === 'base64' ? 'base64' : 'binary');
  return decodeWav(buf);
}

/**
 * Check an IR and say what is in it, in facts a user can act on.
 *
 * Mono and stereo are both supported; more than two channels is refused, because a 5.1 IR cannot be applied
 * to a stereo plugin without a decision nobody has made yet.
 */
export function inspectCab(wav) {
  if (!wav || !Array.isArray(wav.data) || !wav.data.length) return { ok: false, reason: 'no audio channels' };
  if (wav.channels > 2) return { ok: false, reason: `has ${wav.channels} channels; only mono and stereo are supported` };
  const frames = wav.frames;
  if (!frames) return { ok: false, reason: 'contains no samples' };
  let peak = 0;
  for (const ch of wav.data) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
  if (!(peak > 0)) return { ok: false, reason: 'is silent (every sample is zero)' };
  return {
    ok: true,
    channels: wav.channels,
    frames,
    sampleRate: wav.sampleRate,
    peak,
    truncatedTo: Math.min(frames, MAX_CAB_TAPS),
    truncated: frames > MAX_CAB_TAPS,
  };
}

/** A C++ float literal that round-trips: nine significant digits is exact for a float32. */
const f32 = (v) => {
  const s = Number(v).toPrecision(9);
  return /[.e]/.test(s) ? `${s}f` : `${s}.0f`;
};

const cString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * `Source/CabIr.h` — written whether or not there is a cabinet.
 *
 * The same reason as the model's header: `Source/Plugin.cpp` includes it unconditionally and branches on
 * `MORPHEUS_HAS_CAB`, so the plugin source is the same text with a cabinet and without one. That is what
 * keeps the test bench's self-test patch, and every runner proof taken before this existed, independent of
 * what is in the workspace.
 */
export function cabHeader(info) {
  if (!info) {
    return `// Generated by Morpheus — this project has no cabinet impulse response.
//
// It exists so that Source/Plugin.cpp can include it unconditionally. Add a .wav of your cabinet to the
// project (models/ is the conventional place, or name one in morpheus.plugin.json as "cab") and rebuild:
// this header is regenerated, MORPHEUS_HAS_CAB becomes 1, and the plugin convolves your speaker.
#pragma once
#define MORPHEUS_HAS_CAB 0
`;
  }
  return `// Generated by Morpheus from ${info.path} — do not edit; it is rewritten on every build.
//
// The speaker, as ${info.taps} taps at ${info.sampleRate} Hz${info.channels === 2 ? ', stereo' : ', mono'}.
#pragma once
#define MORPHEUS_HAS_CAB 1
#define MORPHEUS_CAB_PATH ${cString(info.path)}
#define MORPHEUS_CAB_TAPS ${info.taps}
#define MORPHEUS_CAB_CHANNELS ${info.channels}
#define MORPHEUS_CAB_RATE ${Math.round(info.sampleRate)}
// The peak of the FILE, before the normalisation below. Written down because a level change nobody
// recorded is the kind of thing found six months later as "the cabinet is quieter than the amp".
#define MORPHEUS_CAB_SOURCE_PEAK ${info.sourcePeak.toFixed(9)}
#define MORPHEUS_CAB_NORMALISED ${info.sourcePeak === 1 ? 0 : 1}${info.truncated ? `\n#define MORPHEUS_CAB_TRUNCATED 1` : ''}

// The taps themselves, normalised so the loudest is 1.0 — see lib/cabIr.js.
extern const float morpheus_cab_l[];
#if MORPHEUS_CAB_CHANNELS == 2
extern const float morpheus_cab_r[];
#endif
`;
}

/**
 * `Source/CabIr.cpp` — the coefficients.
 *
 * Eight a line. A 4096-tap IR is 512 lines; one per line would be 4096 of them, and a compile error in a file
 * like that names a line you cannot read.
 */
export function cabDataSource(info, channels) {
  if (!info) {
    return `// Generated by Morpheus — this project has no cabinet impulse response, so there is nothing to embed.
#include "${CAB_DATA_HEADER.split('/').pop()}"

#if MORPHEUS_HAS_CAB
#error "CabIr.h says there is a cabinet but CabIr.cpp was generated without one"
#endif
`;
  }
  const emit = (name, ch) => {
    const rows = [];
    for (let i = 0; i < ch.length; i += 8) {
      rows.push(`   ${Array.from(ch.subarray(i, i + 8), f32).join(', ')},`);
    }
    return `const float ${name}[MORPHEUS_CAB_TAPS] = {\n${rows.join('\n')}\n};`;
  };
  // ⚠️ A `${...}` INSIDE A C++ `#if` IS NOT GUARDED — the JavaScript runs first, whatever the preprocessor
  // would later decide. Written the obvious way, `emit('morpheus_cab_r', channels[1])` was evaluated for a
  // MONO impulse response too, and the generator crashed on `undefined.length` before any C++ existed. The
  // right channel is emitted only when there is one, which is also the only case the #if can select.
  const right = channels[1]
    ? `#if MORPHEUS_CAB_CHANNELS == 2
${emit('morpheus_cab_r', channels[1])}
#endif
`
    : '';
  return `// Generated by Morpheus from ${info.path} — do not edit; it is rewritten on every build.
//
// THE TAPS, NORMALISED TO A PEAK OF 1.0. Decoded in JavaScript by the project's guarded WAV reader and emitted
// here as floats, so the plugin contains no RIFF parser and loads no file at runtime — the same shape as the
// model next to it.
#include "${CAB_DATA_HEADER.split('/').pop()}"

#if MORPHEUS_HAS_CAB
${emit('morpheus_cab_l', channels[0])}
${right}#endif
`;
}

/**
 * Everything the scaffold needs about this project's cabinet, or null when it has none.
 *
 * Returns the decoded, normalised, truncated channel data as well as the facts, because the emitter and the
 * proof both need the numbers and neither should decode the file a second time.
 */
export function resolveCab(files, manifest = {}) {
  const path = findCabPath(files, manifest);
  if (!path) return { path: null, info: null, channels: null, warnings: [] };
  const file = files.find((f) => f.path === path);

  let wav;
  try {
    wav = decodeCab(file.content, file.encoding || 'base64');
  } catch (err) {
    return { path, info: null, channels: null, warnings: [`${path} is not a readable WAV file — ${String(err.message).split('\n')[0].slice(0, 120)}. Building the plugin WITHOUT a cabinet.`] };
  }
  const inspected = inspectCab(wav);
  if (!inspected.ok) {
    return { path, info: null, channels: null, warnings: [`${path} is not a usable cabinet — it ${inspected.reason}. Building the plugin WITHOUT a cabinet.`] };
  }

  const warnings = [];
  if (inspected.truncated) {
    warnings.push(
      `${path} is ${inspected.frames} samples and only the first ${MAX_CAB_TAPS} are convolved `
      + `(direct convolution costs one multiply per tap per sample; see lib/cabIr.js). The tail is not applied.`,
    );
  }
  if (wav.sampleRate !== 48000) {
    // NOT RESAMPLED, and that is a decision rather than an omission: resampling an IR well is its own piece of
    // DSP, and doing it badly is worse than not doing it. Most cab IRs are 48 kHz.
    warnings.push(`${path} is ${wav.sampleRate} Hz, not 48000 — it is used as-is, so the cabinet will sound shifted in frequency.`);
  }

  const taps = inspected.truncatedTo;
  const normalise = (ch) => {
    const out = new Float32Array(taps);
    for (let i = 0; i < taps; i++) out[i] = ch[i] / inspected.peak;
    return out;
  };
  return {
    path,
    channels: wav.data.slice(0, inspected.channels).map(normalise),
    info: {
      path,
      taps,
      channels: inspected.channels,
      sampleRate: wav.sampleRate,
      sourcePeak: inspected.peak,
      truncated: inspected.truncated,
    },
    warnings,
  };
}

// ── the emitted C++ ──────────────────────────────────────────────────────────────────────────────────────
// The DSP lives here rather than in ampChain.js because the cabinet is not one of the chain's parameters —
// it is a processor that exists when a file does, the same way the model does. Direct convolution with a ring
// buffer: one multiply per tap per sample per channel, which is what MAX_CAB_TAPS is sized against.

/** The ring buffer and the convolution. */
export const cabDspCpp = `// ── the cabinet ──────────────────────────────────────────────────────────────────────────────────────
// DIRECT convolution, and the honest description of the cost: one multiply per tap per sample per channel, so
// a 4096-tap cabinet is 4096 multiplies per sample per channel at 48 kHz. That is affordable on a Pi and it is
// the reason lib/cabIr.js caps the taps. FFT partitioning is the way past the cap and is not built yet.
typedef struct {
   float *hist;          // the last MORPHEUS_CAB_TAPS input samples, newest at pos
   const float *taps;
   int pos;
} cab_t;

static float cab_process(cab_t *c, float x) {
   c->hist[c->pos] = x;
   // ⚠️ ACCUMULATED IN DOUBLE, and the measurement is why. Summing 4096 float products into a float loses
   // precision the taps do not have: the first version nulled against the JavaScript reference at -116 dB,
   // and the whole of that residual was accumulation, not arithmetic. In double it is -150 dB, the FIR costs
   // nothing extra on any CPU this runs on, and the difference between the two is the difference between
   // "close enough" and "the same filter".
   double y = 0.0;
   int idx = c->pos;
   for (int i = 0; i < MORPHEUS_CAB_TAPS; ++i) {
      y += (double)c->taps[i] * (double)c->hist[idx];
      idx = idx ? idx - 1 : MORPHEUS_CAB_TAPS - 1;
   }
   if (++c->pos >= MORPHEUS_CAB_TAPS) c->pos = 0;
   return (float)y;
}`;

/** The per-instance state. */
export const cabStateCpp = `   // One convolution per channel, for the same reason the model has one per channel: a stereo cabinet
   // applied through a single history would smear the two together.
   cab_t cab[2];`;

/**
 * Allocate the history in init(), where allocating is allowed.
 *
 * A cabinet that cannot allocate is a FAILED INIT rather than a silent dry path: half a cabinet is not a
 * quieter amp, it is a different one, and the user would have no way to tell.
 */
export const cabInitCpp = `#if MORPHEUS_HAS_CAB
   for (int c = 0; c < 2; ++c) {
      p->cab[c].hist = (float *)calloc((size_t)MORPHEUS_CAB_TAPS, sizeof(float));
      p->cab[c].pos = 0;
      // ⚠️ THE PREPROCESSOR, NOT A RUNTIME TEST. A ternary on a compile-time constant reads correctly and
      // does not compile: both operands are translated, so a MONO cabinet still names a symbol that was
      // never emitted. Found by clang before any runner was spent.
#if MORPHEUS_CAB_CHANNELS == 2
      p->cab[c].taps = (c == 1) ? morpheus_cab_r : morpheus_cab_l;
#else
      p->cab[c].taps = morpheus_cab_l;
#endif
      if (!p->cab[c].hist) {
         fprintf(stderr, "[%s] could not allocate the cabinet history (%d taps)\\n", MORPHEUS_CAB_PATH, MORPHEUS_CAB_TAPS);
         for (int d = 0; d < 2; ++d) { free(p->cab[d].hist); p->cab[d].hist = NULL; }
         return false;
      }
   }
#endif`;

/** Release it in destroy(). */
export const cabDestroyCpp = `#if MORPHEUS_HAS_CAB
   for (int c = 0; c < 2; ++c) { free(p->cab[c].hist); p->cab[c].hist = NULL; }
#endif`;

/** The stage, per channel. */
export const cabStageCpp = `#if MORPHEUS_HAS_CAB
         // AFTER the model and BEFORE the level: a speaker is part of the amp rather than a processor after
         // it, and a cabinet placed after the output control would change its tone when the level moved.
         if (p->cab[c].hist) x = (double)cab_process(&p->cab[c], (float)x);
#endif`;
