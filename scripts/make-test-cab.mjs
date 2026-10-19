// A deterministic synthetic cabinet impulse response, for builds that have to prove the convolution.
//
// WHY GENERATED RATHER THAN COMMITTED. A real cabinet IR is somebody's work — most are sold, many are
// licensed to a brand, and none of them belong in this repository. This is exponentially decaying noise, which
// is what a speaker impulse looks like (an initial transient and a short tail), from a fixed seed so the same
// numbers come out on every machine and every run.
//
// THE SEEDED GENERATOR IS WRITTEN OUT rather than taken from `lib/audio/signals.js`'s `whiteNoise`, because
// that module's contract is a SIGNAL a measurement is defined against and this is a fixture a build depends
// on: if its sequence ever changed, every stored number from a previous run would silently stop being
// comparable to the next one.
//
// Run:  node scripts/make-test-cab.mjs /tmp/cab.wav
import { writeFileSync } from 'node:fs';
import { encodeWav } from '../server/src/lib/audio/wav.js';

/** 4800 samples is 100 ms at 48 kHz — longer than the 4096-tap cap, so the truncation path is exercised too. */
const TAPS = 4800;
const TAU = 800;
const SEED = 7;
const PEAK = 0.35;
const SAMPLE_RATE = 48000;

const out = process.argv[2] || 'test-cab.wav';

// A linear congruential generator with the constants from Numerical Recipes, kept here so the sequence is
// pinned by this file rather than by a library's implementation.
let x = SEED;
const next = () => {
  x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
  return (x / 0x7fffffff) * 2 - 1;
};

const ir = new Float64Array(TAPS);
for (let i = 0; i < TAPS; i++) ir[i] = next() * Math.exp(-i / TAU) * PEAK;

let peak = 0;
for (const v of ir) peak = Math.max(peak, Math.abs(v));
writeFileSync(out, encodeWav({ sampleRate: SAMPLE_RATE, data: ir, format: 'float32' }));
console.log(`[make-test-cab] wrote ${out}: ${TAPS} taps at ${SAMPLE_RATE} Hz, peak ${peak.toFixed(4)}`);
