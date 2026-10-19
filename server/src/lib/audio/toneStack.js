// The tone stack: three biquads whose response is a designed number, so the plugin's can be measured against it.
//
// WHY THIS IS A SHARED MODULE RATHER THAN A GENERATED STRING. The plugin implements these filters in C++ and
// this file implements them in JavaScript, and that is deliberate rather than duplication to be avoided: the
// JS one is the DESIGN, the C++ one is what runs, and `scripts/audio-amp-chain-check.mjs` measures the
// plugin's actual frequency response through the offline host and compares it to this design. Two
// implementations that have to agree on a measured number is a proof; one implementation checked against
// itself is a comment.
//
// The numbers are the RBJ Audio EQ Cookbook's, which is also what `lib/audio/dsp.js` already implements —
// so this file adds no filter maths of its own, it only names the three bands and combines them.
import { biquadCoefficients, biquadProcess, biquadResponseDb } from './dsp.js';

/**
 * The three bands, and the corners are a choice rather than a standard.
 *
 * A guitar amp's tone stack is not a mixing EQ: it is three broad, overlapping, low-Q shapes that a player
 * sweeps by ear. These sit where the ear expects them on a guitar — 100 Hz for the cabinet's low end, 800 Hz
 * for the midrange a amp lives in, 3 kHz for the bite — and the Q values are deliberately gentle (0.7), so
 * moving one band does not leave a hole where another used to be.
 *
 * THEY ARE GENERATED INTO THE PLUGIN FROM HERE. `ampChain.js` emits these frequencies and Q values into the
 * C++, so a change here is a change there — the alternative is a plugin whose corners are right in the
 * measurement and wrong in the build.
 */
export const TONE_BANDS = [
  { key: 'bass', label: 'Bass', type: 'lowshelf', freq: 100, q: Math.SQRT1_2, rangeDb: 12 },
  { key: 'mid', label: 'Mid', type: 'peak', freq: 800, q: 0.7, rangeDb: 12 },
  { key: 'treble', label: 'Treble', type: 'highshelf', freq: 3000, q: Math.SQRT1_2, rangeDb: 12 },
];

/** The band keys, in signal order — the order the plugin applies them must match the order used here. */
export const TONE_KEYS = TONE_BANDS.map((b) => b.key);

/**
 * The three filters for one setting of the three controls.
 *
 * `gains` takes the band keys; anything missing is 0 dB, so `toneDesign({ sampleRate })` is the flat setting
 * rather than an error. A flat design is not the identity — a shelf at 0 dB still has coefficients — which is
 * the sort of thing that is worth knowing when a null test is being read.
 */
export function toneDesign({ gains = {}, sampleRate }) {
  const out = {};
  for (const band of TONE_BANDS) {
    out[band.key] = biquadCoefficients({
      type: band.type,
      freq: band.freq,
      q: band.q,
      gainDb: Number(gains[band.key] ?? 0),
      sampleRate,
    });
  }
  return out;
}

/** The tone stack applied to a signal, band by band, in the same order the plugin applies it. */
export function toneProcess(design, x) {
  let y = x;
  for (const key of TONE_KEYS) y = biquadProcess(design[key], y);
  return y;
}

/** The combined response of the three bands at one frequency, in dB. */
export function toneResponseDb(design, freq, sampleRate) {
  let db = 0;
  for (const key of TONE_KEYS) db += biquadResponseDb(design[key], freq, sampleRate);
  return db;
}

/** The same, at a list of frequencies — what the measurement is compared against. */
export function toneCurveDb(design, freqs, sampleRate) {
  return freqs.map((f) => ({ freq: f, db: toneResponseDb(design, f, sampleRate) }));
}
