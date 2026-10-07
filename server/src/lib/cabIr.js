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
// Impulse responses arrive at wildly different levels, so the taps are re-scaled at bake time and BOTH
// numbers are recorded — the file's own peak, and the gain this build applied. A level change that nobody
// wrote down is the kind of thing that gets discovered six months later as "the cabinet sounds quieter than
// the amp"; this one is in the header, in the proof file, and in the manual.
//
// ⚠️ AND THE TARGET IS PROGRAMME MATERIAL, NOT A PEAK — WHICH IT WAS, AND THAT WAS WRONG. Peak normalisation
// fixes a waveform's tallest sample and says nothing about its LOUDNESS, so a real 4x12 IR with 4096 taps of
// tail came out about +15 dB LOUDER than the amplifier it is supposed to be the speaker of: measured through
// the demo chain on a Marshall G12M pack, cabinet off -10.7 dBFS RMS and cabinet on +5.1 dBFS RMS with a peak
// of +18.8 dBFS — clipping, the moment the cabinet was switched on. A plugin that does that is not a cabinet.
// The taps are scaled to the gain PINK NOISE sees instead, so the speaker keeps a musical signal's level and a
// first build is usable without reaching for the Output control. See `cabTapGain`, which is the one definition
// of that rule and the one the checks measure against.
import { decodeWav } from './audio/wav.js';
import { rigList } from './rig.js';

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
export function findCabPaths(files, manifest = {}) {
  return rigList({ files, manifest, listKey: 'cabs', oneKey: 'cab', has: hasCab, match: (p) => /\.wav$/i.test(p), rank });
}

/** The FIRST impulse response — the singular finder, unchanged in what it returns. See findCabPaths. */
export function findCabPath(files, manifest = {}) {
  const all = findCabPaths(files, manifest);
  return all.length ? all[0].path : null;
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
 *
 * ⭐ AND IT DECLARES THE CABINET RIG, WHEN THERE IS ONE. The table is DEFINED in `CabIr.cpp` (see
 * `cabRigTableCpp`), a different translation unit from the plugin, so `Plugin.cpp` can only index it through
 * a declaration here. `cabs` is the resolved rig; the count comes through the same filter the `.cpp` uses, so
 * the header and the table cannot come to disagree about how many speakers there are.
 *
 * ⚠️ A RIG OF FEWER THAN TWO DECLARES NOTHING, AND IT HAS TO BE THAT WAY ROUND. One speaker has nothing to
 * choose between, so `cabDataSourceAll` emits no table — a declaration here would promise a symbol the
 * `.cpp` never defines and the project would fail to link. It is also what keeps this header's bytes
 * unchanged for every project that has no rig.
 */
export function cabHeader(info, cabs = null) {
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
  const rig = usableCabs(cabs);
  const rigDecl = rig.length >= 2 ? `
// ⭐ THE CABINET RIG, declared here because its definition is in CabIr.cpp. \`static\` is what it cannot be
// there: the plugin is a different translation unit, so the table needs external linkage to be readable.
#if MORPHEUS_HAS_CAB
#define MORPHEUS_RIG_CABS ${rig.length}
struct morpheus_rig_cab { const char *name; const float *left; const float *right; unsigned int taps; int channels; };
extern const morpheus_rig_cab kMorpheusRigCabs[MORPHEUS_RIG_CABS];
#endif
` : '';
  return `// Generated by Morpheus from ${info.path} — do not edit; it is rewritten on every build.
//
// The speaker, as ${info.taps} taps at ${info.sampleRate} Hz${info.channels === 2 ? ', stereo' : ', mono'}.
#pragma once
#define MORPHEUS_HAS_CAB 1
#define MORPHEUS_CAB_PATH ${cString(info.path)}
#define MORPHEUS_CAB_TAPS ${info.taps}
#define MORPHEUS_CAB_CHANNELS ${info.channels}
#define MORPHEUS_CAB_RATE ${Math.round(info.sampleRate)}
// The peak of the FILE, before the normalisation below, and the gain this build applied to it. Written down
// because a level change nobody recorded is the kind of thing found six months later as "the cabinet is
// quieter than the amp".
#define MORPHEUS_CAB_SOURCE_PEAK ${info.sourcePeak.toFixed(9)}
// The gain this build applied to the file's samples, in dB. Positive means the taps were made LOUDER.
#define MORPHEUS_CAB_APPLIED_DB ${Number(info.appliedGainDb ?? 0).toFixed(4)}
#define MORPHEUS_CAB_NORMALISED ${info.sourcePeak === 1 ? 0 : 1}${info.truncated ? `\n#define MORPHEUS_CAB_TRUNCATED 1` : ''}

// The taps themselves, scaled to the gain PINK NOISE sees — so the cabinet keeps a musical signal's level
// rather than setting it from its tallest sample. See lib/cabIr.js; the applied gain is above.
extern const float morpheus_cab_l[];
#if MORPHEUS_CAB_CHANNELS == 2
extern const float morpheus_cab_r[];
#endif
${rigDecl}`;
}

/**
 * One channel of an IR as a C++ float array, eight a line.
 *
 * Shared by the first cabinet and by every extra one, so two arrays of the same taps cannot differ in layout
 * for a reason nobody could name. ⚠️ THE TAPS MACRO IS A PARAMETER because each member's array is sized by its
 * OWN count — the first by the header's `MORPHEUS_CAB_TAPS`, an extra by the count emitted beside it — and a
 * shared hard-coded macro would silently size every cabinet after the first as the first one.
 */
function cabTapsCpp(name, ch, tapsMacro) {
  const rows = [];
  for (let i = 0; i < ch.length; i += 8) {
    rows.push(`   ${Array.from(ch.subarray(i, i + 8), f32).join(', ')},`);
  }
  return `const float ${name}[${tapsMacro}] = {\n${rows.join('\n')}\n};`;
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
  const emit = (name, ch) => cabTapsCpp(name, ch, 'MORPHEUS_CAB_TAPS');
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
 * The members of a cabinet rig that can actually be emitted — the ONE filter the header's count and the
 * `.cpp`'s table have to agree on.
 *
 * ⚠️ TWO FILTERS THAT MEAN THE SAME THING ARE TWO FILTERS THAT DRIFT, and the failure is a header promising
 * three entries beside a table that holds two. `resolveCabs` keeps an unusable member so its warning reaches
 * the scaffold (see `cabDataSourceAll`); it has no taps, so it is not a row.
 *
 * ⭐ EXPORTED, BECAUSE THE SELECTOR'S RANGE IS THIS SAME COUNT. `scaffoldPlugin` asks it for the number of
 * speakers the rig offers (see `rigSelectors`), so a cabinet dropped from the table cannot leave a selector
 * position that convolves nothing — the count, the table and the parameter come from one filter.
 */
export const usableCabs = (cabs) => (Array.isArray(cabs) ? cabs : [])
  .filter((c) => c && c.info && Array.isArray(c.channels) && c.channels.length);

/**
 * `Source/CabIr.cpp` for a whole RIG — one impulse response, several, or none.
 *
 * The same shape as `modelDataSourceAll`, for the same reason and with the same guarantee: the first cabinet
 * is emitted through `cabDataSource`, unchanged, and everything else is appended after it, so a one-cabinet
 * project's source is byte for byte what it always was. Every proof taken of the plugin's speaker — the
 * measured pink-noise gain, the null against the JavaScript reference — measured that text.
 *
 * ⭐ AND A RIG OF ONE IS THE SINGULAR EMISSION ENTIRELY — NO TABLE. With one speaker there is nothing to
 * choose between, and the table is exactly the bytes that would stop a one-cabinet project's source matching
 * what every existing proof measured. `morpheus_cab_l` is the runtime's answer for M == 1; the table is for
 * M >= 2.
 *
 * ⚠️ AN UNUSABLE CABINET IS DROPPED, NOT EMBEDDED EMPTY. `resolveCabs` keeps it as a member so its warning
 * reaches the scaffold; a zero-length tap array would convolve the signal with nothing and read to the user as
 * a cabinet that loads and does not work — which is worse than the warning that says it was left out.
 */
export function cabDataSourceAll(cabs) {
  const rig = usableCabs(cabs);
  if (!rig.length) return cabDataSource(null, null);
  // ⭐ M == 1 IS THE SINGULAR EMISSION, VERBATIM — the cab half of the same rule, for the same reason.
  if (rig.length === 1) return cabDataSource(rig[0].info, rig[0].channels);

  const extras = rig.slice(1).map((c, i) => cabExtraCpp(c, i + 2)).join('\n');
  return `${cabDataSource(rig[0].info, rig[0].channels)}
#if MORPHEUS_HAS_CAB
${extras ? `${extras}\n` : ''}${cabRigTableCpp(rig)}#endif
`;
}

/** The array a rig member's channel lives in. The first is unsuffixed because it is the symbol that exists. */
const cabArrayName = (index, side) => `morpheus_cab_${side}${index === 0 ? '' : `_${index + 1}`}`;

/**
 * One extra cabinet: its own shape macros and its own taps.
 *
 * ⚠️ THE MACROS COME BEFORE THE ARRAY THAT READS THEM, because each array is sized by its own tap count. A
 * second cabinet longer than the first would otherwise be emitted at the first one's length — a compile error,
 * which is the good kind, but only after a build has been spent.
 */
function cabExtraCpp(cab, index) {
  const taps = `MORPHEUS_CAB_TAPS_${index}`;
  // ⚠️ THE SAME TRAP `cabDataSource` DOCUMENTS: the right channel is emitted only when there is one, because
  // a `${...}` inside a C++ `#if` is not guarded — the JavaScript runs before any preprocessor exists, and
  // `channels[1]` on a mono IR is `undefined`.
  const right = cab.channels[1]
    ? `\n${cabTapsCpp(cabArrayName(index - 1, 'r'), cab.channels[1], taps)}`
    : '';
  return `// ── cabinet ${index}: ${cab.name} (from ${cab.path})
// The same decode, normalisation and truncation as the first; these are the facts its own array is sized by.
#define ${taps} ${cab.info.taps}
#define MORPHEUS_CAB_CHANNELS_${index} ${cab.info.channels}
#define MORPHEUS_CAB_RATE_${index} ${Math.round(cab.info.sampleRate)}
${cabTapsCpp(cabArrayName(index - 1, 'l'), cab.channels[0], taps)}${right}
`;
}

/**
 * THE CABINET RIG, in selector order — emitted only when there are two or more speakers to select between.
 *
 * ⭐ `right` IS `nullptr` RATHER THAN A REPEATED LEFT CHANNEL, so a mono cabinet says so in the table instead
 * of the runtime having to compare arrays to find out. ⚠️ AND IT IS A JS-TIME CHOICE, NOT A C++ `#if`: a mono
 * cabinet must emit no `morpheus_cab_r` TEXT AT ALL — the guard asserts exactly that — and the preprocessor
 * cannot un-print a symbol whose name the generator already wrote. ⚠️ `nullptr` and not `NULL` because this
 * file includes only `CabIr.h`, which pulls in no `<stddef.h>`, so `NULL` is the one word that does not exist
 * here; found by compiling the emitted rig rather than by reading it.
 *
 * ⭐ THE TYPE AND THE COUNT LIVE IN THE HEADER, and this definition repeats neither — `morpheus_rig_cab` is
 * declared in `CabIr.h` because `Plugin.cpp` indexes the table, and `MORPHEUS_RIG_CABS` sits beside that
 * declaration. The two files therefore cannot disagree about how many rows there are.
 *
 * ⚠️ IT IS `const`, NOT `static const`, AND THAT IS A LINK ERROR RATHER THAN A STYLE CHOICE. A `static` table
 * has internal linkage, so the `extern` declaration in the header would resolve to a symbol this translation
 * unit never exports and the plugin would fail to link. A syntax-only compile cannot see it; found by
 * compiling the emitted rig rather than by reading it.
 */
function cabRigTableCpp(rig) {
  const rows = rig.map((cab, i) => {
    const right = cab.channels[1] ? cabArrayName(i, 'r') : 'nullptr';
    const taps = i === 0 ? 'MORPHEUS_CAB_TAPS' : `MORPHEUS_CAB_TAPS_${i + 1}`;
    const channels = i === 0 ? 'MORPHEUS_CAB_CHANNELS' : `MORPHEUS_CAB_CHANNELS_${i + 1}`;
    return `   { ${cString(cab.name)}, ${cabArrayName(i, 'l')}, ${right}, (unsigned int)${taps}, ${channels} },`;
  }).join('\n');
  return `const morpheus_rig_cab kMorpheusRigCabs[] = {
${rows}
};
`;
}

/**
 * EVERY impulse response this project carries, in the order the rig should offer them.
 *
 * The same contract as `resolveModels`, because a rig has two halves and they must behave the same way: the
 * finder's order is the selector's order, and a `.wav` that is present but unusable stays a MEMBER carrying a
 * warning rather than quietly vanishing. `cabDataSourceAll` is what drops it from the emitted taps. A player
 * whose second mic capture is a silent file, or a 5.1 WAV this plugin cannot convolve, needs to be told — not
 * left counting arrays in a generated header.
 */
export function resolveCabs(files, manifest = {}) {
  return findCabPaths(files, manifest).map(({ path, name }) => resolveCabMember(files, path, name));
}

/** The FIRST impulse response — what this function has always returned. See resolveCabs. */
export function resolveCab(files, manifest = {}) {
  const all = resolveCabs(files, manifest);
  return all.length ? all[0] : { path: null, info: null, channels: null, warnings: [] };
}

/**
 * One member of the cabinet rig, in the shape the singular resolver has always returned.
 *
 * Returns the decoded, normalised, truncated channel data as well as the facts, because the emitter and the
 * proof both need the numbers and neither should decode the file a second time.
 */
function resolveCabMember(files, path, name) {
  const file = files.find((f) => f.path === path);

  let wav;
  try {
    wav = decodeCab(file.content, file.encoding || 'base64');
  } catch (err) {
    return { path, name, info: null, channels: null, warnings: [`${path} is not a readable WAV file — ${String(err.message).split('\n')[0].slice(0, 120)}. It is left out of the rig; a rig with no usable cabinet convolves nothing.`] };
  }
  const inspected = inspectCab(wav);
  if (!inspected.ok) {
    return { path, name, info: null, channels: null, warnings: [`${path} is not a usable cabinet — it ${inspected.reason}. It is left out of the rig; a rig with no usable cabinet convolves nothing.`] };
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
  const gain = cabTapGain(wav.data.slice(0, inspected.channels), taps);
  const normalise = (ch) => {
    const out = new Float32Array(taps);
    for (let i = 0; i < taps; i++) out[i] = ch[i] / gain;
    return out;
  };
  return {
    path,
    name,
    channels: wav.data.slice(0, inspected.channels).map(normalise),
    info: {
      path,
      taps,
      channels: inspected.channels,
      sampleRate: wav.sampleRate,
      sourcePeak: inspected.peak,
      // The gain the bake applied, in dB — a POSITIVE number here means the taps were made LOUDER than the
      // file, which is what a quiet IR gets. Written down for the same reason the source peak is.
      appliedGainDb: -20 * Math.log10(gain),
      truncated: inspected.truncated,
    },
    warnings,
  };
}

/**
 * THE ONE RULE FOR A BAKED IR'S LEVEL, in a function so the baker and the checks cannot disagree about it.
 *
 * ⚠️ IT IS THE GAIN FOR PROGRAMME MATERIAL, AND GETTING THIS WRONG IS WHY A CABINET USED TO CLIP. The taps
 * are scaled so the convolution leaves a BROADBAND MUSICAL signal at the level it arrived at — the level of
 * PINK noise, which is the standard stand-in for music because it carries equal power per octave, the way a
 * guitar's spectrum roughly does.
 *
 * Three ways to set this, and the two obvious ones are both wrong:
 *   • A PEAK OF 1.0 (what this did): fixes a waveform's tallest sample and says nothing about its loudness. A
 *     real 4x12 IR with 4096 taps of tail came out **+15 dB loud**, and clipped the moment it was switched on.
 *   • UNIT ENERGY, `sqrt(sum of squares)` — the textbook "RMS normalisation": exact for WHITE noise and
 *     **7 dB short for a guitar**, because a speaker puts its energy in the low mids while white noise spreads
 *     it evenly. Measured: a real guitar DI came out **+7.2 dB** through a cabinet normalised this way.
 *   • THE LOUDEST FREQUENCY, a "a speaker never boosts" rule: safe, and **6 dB too quiet**.
 *
 * ✨ AND PINK NOISE NEEDS NO REFERENCE BUFFER. Pink noise carries equal power per octave, so a set of
 * LOG-SPACED frequencies weights every octave equally — and the mean of |H(f)|² over them IS the pink-noise
 * power gain. No FFT, no seeded noise, no fixture. Measured on a Marshall G12M pack through the demo chain,
 * this lands a real guitar DI at **-1.0 dB**: no clip, and nothing to turn down before the plugin is usable.
 *
 * Summed across the channels that are actually baked, so a stereo IR keeps a broadband signal's level as a
 * PAIR rather than per channel — see `resolveCabMember`, which divides every channel by this one number so the
 * stereo image is untouched.
 *
 * Returns 1 for silence, which `inspectCab` has already refused — the guard is for the caller's sake.
 */
export function cabTapGain(channels, taps = MAX_CAB_TAPS, sampleRate = 48000) {
  // 30 Hz to 16 kHz, a twentieth of an octave apart. Below and above that a guitar cabinet has nothing to
  // say, and a twentieth of an octave is fine enough that the mean is stable — the same range and step the
  // measurement above used, deliberately, so the number in this comment is the number this code computes.
  let power = 0;
  let bins = 0;
  for (let f = 30; f <= 16000; f *= 1.05) {
    const w = (2 * Math.PI * f) / sampleRate;
    for (const ch of channels) {
      const n = Math.min(taps, ch.length);
      let re = 0;
      let im = 0;
      for (let i = 0; i < n; i++) {
        re += ch[i] * Math.cos(w * i);
        im += ch[i] * Math.sin(w * i);
      }
      power += re * re + im * im;
    }
    bins++;
  }
  const gain = bins > 0 ? Math.sqrt(power / bins) : 0;
  return gain > 0 ? gain : 1;
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

// ── the cabinet RIG ──────────────────────────────────────────────────────────────────────────────────────
// ⭐ A RIG'S CABINETS ARE TABLES OF TAPS, NOT A RUNTIME ENGINE, SO WHAT IS SWAPPED IS THE POINTER AND TWO
// NUMBERS. Unlike the model — which is a `nam::DSP` built once per capture in init() — a cabinet was never a
// runtime object: the taps are baked C++ arrays and the state is a ring buffer. So the rig's second speaker
// needs no second kind of thing, only the same convolution with ITS OWN tap count in the loop bound and the
// ring wrap. The members genuinely differ in length (a 256-tap close mic beside a 4096-tap room), which is
// why the count cannot stay the first cabinet's `MORPHEUS_CAB_TAPS`.
//
// ⚠️ EVERYTHING BELOW IS EMITTED ONLY FOR A RIG OF TWO OR MORE. A one-cabinet project keeps `cab_t`,
// `cab_process`, `MORPHEUS_CAB_TAPS` and the singular fragments byte for byte, which is what every existing
// measurement of the speaker was taken against (see `cabDataSourceAll`).

/**
 * The ring buffer and the convolution, for one SELECTED member.
 *
 * `taps_count` is the member's own tap count, not `MORPHEUS_CAB_TAPS`: the history is allocated for exactly
 * this many samples, and using the first cabinet's number for a longer one would read past the end of the
 * array while using it for a shorter one would convolve stale samples that no longer belong to the tail.
 */
export const cabRigDspCpp = `typedef struct {
   float *hist;          // this member's own history, \`taps_count\` long, newest at pos
   const float *taps;
   int taps_count;       // THIS member's taps — see the note in lib/cabIr.js
   int pos;
} cab_rig_t;

static float cab_rig_process(cab_rig_t *c, float x) {
   c->hist[c->pos] = x;
   // ⚠️ ACCUMULATED IN DOUBLE, exactly as the singular convolution is: the -148 dB null against the
   // JavaScript reference is a property of the summation, not of one cabinet, and a rig member measured in
   // float would be a different filter from the same taps measured alone.
   double acc = 0.0;
   int idx = c->pos;
   for (int i = 0; i < c->taps_count; ++i) {
      acc += (double)c->taps[i] * (double)c->hist[idx];
      idx = idx ? idx - 1 : c->taps_count - 1;
   }
   if (++c->pos >= c->taps_count) c->pos = 0;
   return (float)acc;
}`;

/** The per-instance state: one history per member per channel, so switching mics does not share a tail. */
export const cabRigStateCpp = `   // ⭐ ONE CONVOLUTION PER MEMBER PER CHANNEL. Per member, because each speaker has its own tap count and
   // its own history; per channel, for the same reason the singular cabinet has two — a stereo speaker
   // applied through one history smears the channels together.
   cab_rig_t cab[MORPHEUS_RIG_CABS][2];`;

/**
 * Allocate every member's history in init(), where allocating is allowed.
 *
 * ⚠️ A FAILED ALLOCATION IS A FAILED INIT, NOT A SILENT DRY PATH — the singular rule, for the same reason.
 * It releases every buffer it has taken so far rather than leaving half a rig behind, because a plugin that
 * half-loaded is a different amplifier rather than a quieter one.
 */
export const cabRigInitCpp = `#if MORPHEUS_HAS_CAB
   for (int i = 0; i < MORPHEUS_RIG_CABS; ++i) {
      const int taps = (int)kMorpheusRigCabs[i].taps;
      for (int c = 0; c < 2; ++c) {
         p->cab[i][c].hist = (float *)calloc((size_t)taps, sizeof(float));
         p->cab[i][c].pos = 0;
         p->cab[i][c].taps_count = taps;
         // ⚠️ A MONO MEMBER'S RIGHT CHANNEL IS THE SAME ARRAY AS ITS LEFT, which is what the table's
         // \`nullptr\` right entry MEANS (see cabRigTableCpp). It is not a second decode and not silence.
         p->cab[i][c].taps = (c == 1 && kMorpheusRigCabs[i].right) ? kMorpheusRigCabs[i].right : kMorpheusRigCabs[i].left;
         if (!p->cab[i][c].hist) {
            fprintf(stderr, "[%s] could not allocate the cabinet history (%d taps)\\n", kMorpheusRigCabs[i].name, taps);
            for (int d = 0; d < MORPHEUS_RIG_CABS; ++d) {
               for (int e = 0; e < 2; ++e) { free(p->cab[d][e].hist); p->cab[d][e].hist = NULL; }
            }
            return false;
         }
      }
   }
#endif`;

/** Release every member's history in destroy(). */
export const cabRigDestroyCpp = `#if MORPHEUS_HAS_CAB
   for (int i = 0; i < MORPHEUS_RIG_CABS; ++i) {
      for (int c = 0; c < 2; ++c) { free(p->cab[i][c].hist); p->cab[i][c].hist = NULL; }
   }
#endif`;

/**
 * The stage, per channel, for a rig.
 *
 * ⭐ THE SELECTION IS A POINTER SWAP. `morpheus_cab_index` clamps the parameter to a table row, and the row
 * decides which taps and which tap count run — no allocation, no parse, nothing but an array subscript on
 * the audio thread. Switching speakers mid-note is therefore a change of filter between samples, which is
 * the only shape that works while a player is playing.
 */
export const cabRigStageCpp = `#if MORPHEUS_HAS_CAB
         // AFTER the model and BEFORE the level: a speaker is part of the amp rather than a processor after
         // it, and a cabinet placed after the output control would change its tone when the level moved.
         {
            const int cab_sel = morpheus_cab_index(p->value[IDX_CAB_SELECT]);
            if (p->cab[cab_sel][c].hist) x = (double)cab_rig_process(&p->cab[cab_sel][c], (float)x);
         }
#endif`;
