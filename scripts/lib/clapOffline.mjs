// Shared scaffolding for the tools that compile a generated plugin and play audio through it.
//
// ── ⚠️ WHY THIS EXISTS, AND THE TWO MISTAKES THAT MADE IT NECESSARY ───────────────────────────────────────
// `audio-testbench.mjs`, `spring-check.mjs` and `drive-check.mjs` all do the same four things: compile the
// plugin's own CLAP sources against the offline host, write a signal in the host's container, run it, and read
// the result back. Written out three times, that is three chances to get the same two details wrong — and both
// of them WERE wrong, in separate scripts, in the same afternoon:
//
//   1. THE HOST PRINTS TWO JSON LINES — the descriptor and a timing report. Taking the last one, or assuming
//      there is only one, silently reads the wrong object. (In `audio-testbench.mjs` that turned into a crash
//      before a single measurement; see the note there.)
//   2. THE CHANNEL COUNT IS NOT A GUESS. A one-channel MRAW read back with a two-channel stride (or the
//      reverse) doubles or halves the sample rate, so a 1 kHz tone measures as 2 kHz and a THD figure comes
//      out ABOVE 100% — which is what a nonsense measurement looks like rather than what a broken plugin does.
//      It happened twice: once making a spring reverb appear to fire a second late, and once in this tool's
//      own first version. Every function here reads the header it was given, and `render()` returns the
//      channel count so a caller never has to assume one.
//
// The measurements themselves stay in the tools: what to ask of a spring reverb and what to ask of a drive are
// different questions, and a shared answer would be a shared mistake.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

/** Where the repo is, from this file's own position. */
export const ROOT = join(dirname(new URL(import.meta.url).pathname), '..', '..');

/** The CLAP headers, cached by the test bench, or wherever the caller says. Exits 2 when it cannot find them. */
export function clapIncludeDir(explicit = null) {
  const dir = explicit || process.env.CLAP_INCLUDE || join(ROOT, '.cache', 'clap', 'include');
  if (!existsSync(join(dir, 'clap', 'clap.h'))) {
    console.error(`no CLAP headers under ${dir}\n  ...their absence is not a plugin fault. Fetch them with\n`
      + '  git clone https://github.com/free-audio/clap .cache/clap && git -C .cache/clap checkout a47f6badb49d948fd009998f28309cdab78979c9\n'
      + '  or pass --clap-include <dir> / set CLAP_INCLUDE.');
    process.exit(2);
  }
  return dir;
}

/**
 * Compile a generated plugin's own sources against the offline host.
 *
 * The plugin's sources are LINKED, not dlopened: this measures the CLAP core the generator wrote, and it does
 * so without Xcode, MSVC or a two-minute SDK configure. The wrapped VST3/AU/standalone bundles are a different
 * question and are proved by the runner builds.
 */
export function buildOfflineHost({ projectDir, work, clapInclude, cxx = process.env.CXX ?? 'c++' }) {
  const src = join(projectDir, 'Source', 'Plugin.cpp');
  const entry = join(projectDir, 'Source', 'PluginEntry.cpp');
  if (!existsSync(src)) {
    console.error(`${src} does not exist — --plugin wants a GENERATED plugin project directory.`);
    process.exit(2);
  }
  mkdirSync(work, { recursive: true });
  const bin = join(work, 'clap_offline');
  const r = spawnSync(cxx, [
    '-std=c++20', '-O2', '-w',
    `-I${clapInclude}`,
    `-I${join(projectDir, 'Source')}`,
    join(ROOT, 'tools', 'clap-offline', 'clap_offline.cpp'),
    src, entry, '-o', bin,
  ], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`compilation failed:\n${r.stderr || r.stdout}`);
    process.exit(1);
  }
  return bin;
}

// ── the MRAW container ──────────────────────────────────────────────────────────────────────────────────────
export function writeMraw(path, sampleRate, channels, frames) {
  const head = Buffer.alloc(20);
  head.write('MRAW', 0, 'ascii');
  head.writeUInt32LE(1, 4);
  head.writeUInt32LE(sampleRate, 8);
  head.writeUInt32LE(channels.length, 12);
  head.writeUInt32LE(frames, 16);
  const body = Buffer.alloc(frames * channels.length * 4);
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels.length; c++) body.writeFloatLE(channels[c][f], (f * channels.length + c) * 4);
  }
  writeFileSync(path, Buffer.concat([head, body]));
}

/** Every channel, and the count — so a caller cannot render a mono signal by accident. */
export function readMraw(path) {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'MRAW') throw new Error(`${path} is not MRAW`);
  const sampleRate = buf.readUInt32LE(8);
  const channels = buf.readUInt32LE(12);
  const frames = buf.readUInt32LE(16);
  const out = Array.from({ length: channels }, () => new Float64Array(frames));
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) out[c][f] = buf.readFloatLE((f * channels + c) * 4 + 20);
  }
  return { sampleRate, channels, frames, data: out };
}

/**
 * The plugin's own descriptor, read from the host rather than assumed.
 *
 * Returns the object with an `id` — the descriptor — and never the timing report, whatever order they arrive
 * in and however many there turn out to be.
 */
export function describePlugin(bin, testFile) {
  const r = spawnSync(bin, ['--in', testFile, '--out', testFile, '--list-params'], { encoding: 'utf8' });
  const reports = (r.stdout || '').trim().split('\n')
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  const info = reports.find((o) => o && typeof o.id === 'string');
  if (!info) {
    console.error(`the host printed no plugin descriptor.\n  exit ${r.status}\n  stdout: ${(r.stdout || '').trim()}\n  stderr: ${(r.stderr || '').trim()}`);
    process.exit(2);
  }
  return info;
}

/** Render one file through the host, with parameters addressed BY ID. Returns every channel and the timing. */
export function render(bin, { inPath, outPath, params = [], blockSize = 64 }) {
  const argv = ['--in', inPath, '--out', outPath, '--blocksize', String(blockSize)];
  for (const [id, v] of params) argv.push('--param', `${id}=${v}`);
  const r = spawnSync(bin, argv, { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`the plugin failed to render: ${r.stderr || r.stdout}`);
    process.exit(1);
  }
  const reports = (r.stdout || '').trim().split('\n')
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  return { ...readMraw(outPath), timing: reports.find((o) => o && o.processSeconds != null) || null };
}

/**
 * The amplitude of one frequency in a signal, by Goertzel — exact at a bin when the window is a whole number of
 * cycles, which is why every caller uses a 1 kHz or 4 kHz tone over a whole number of samples.
 */
export function magnitudeAt(signal, hz, sampleRate, fromSample, length) {
  const w = (2 * Math.PI * hz) / sampleRate;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < length; i++) {
    const s0 = signal[fromSample + i] + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return (2 * Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2)) / length;
}

export const rmsOf = (signal, fromSample, length) => {
  let e = 0;
  for (let i = 0; i < length; i++) e += signal[fromSample + i] * signal[fromSample + i];
  return Math.sqrt(e / length);
};

export const meanOf = (signal, fromSample, length) => {
  let e = 0;
  for (let i = 0; i < length; i++) e += signal[fromSample + i];
  return e / length;
};

/**
 * Total harmonic distortion of a steady tone, from the harmonics above it.
 *
 * ⚠️ IT STOPS BELOW NYQUIST, and a THD figure above 100% is what happens when it does not. Above Nyquist there
 * is no harmonic to measure — what a DFT at that frequency finds is whatever ALIASED down onto it, so counting
 * the 6th harmonic of a 4 kHz tone measures the 6th folding back onto Nyquist rather than distortion. A drive
 * at 48 kHz genuinely does alias (there is no oversampling here, and that is worth knowing), but it is a
 * different question from this one and it was answering it by accident.
 */
export function thdOf(signal, fundamental, sampleRate, fromSample, length, harmonics = 12) {
  const f = magnitudeAt(signal, fundamental, sampleRate, fromSample, length);
  const last = Math.min(harmonics, Math.floor((sampleRate / 2 - 1) / fundamental));
  let h = 0;
  for (let k = 2; k <= last; k++) h += magnitudeAt(signal, fundamental * k, sampleRate, fromSample, length) ** 2;
  return Math.sqrt(h) / f;
}

export const dbOf = (x) => 20 * Math.log10(Math.abs(x) + 1e-30);

/** A steady sine, zero everywhere else, starting late enough that every parameter smoother has settled. */
export function sineIn(frames, sampleRate, { hz = 1000, amplitude = 0.2, startAt = 0.5, stopBefore = 0.05 } = {}) {
  const sig = new Float64Array(frames);
  const a = Math.round(startAt * sampleRate);
  const b = frames - Math.round(stopBefore * sampleRate);
  for (let i = a; i < b; i++) sig[i] = amplitude * Math.sin((2 * Math.PI * hz * (i - a)) / sampleRate);
  return sig;
}
