// Does the spring reverb behave like a SPRING — not like a plate, and not like a delay with a filter in it?
//
// ── WHY THIS IS A TOOL AND NOT A GUARD ───────────────────────────────────────────────────────────────────
// It compiles the generated plugin and renders audio through it, which needs a compiler and the CLAP headers.
// The `guards (no install)` job has neither, and a check that cannot run is worse than no check (H17). So the
// claims this proves are pinned in `verify-audio-plugin.mjs` as TEXT assertions on the emitted C++ — the
// coefficient's sign, the control table, the marker replacement — and the audio itself is proved here, by a
// person or a runner, when a block changes.
//
// ── THE THREE CLAIMS, AND WHY EACH ONE IS THE ONE IT IS ───────────────────────────────────────────────────
//   1. IT DECAYS, and the Decay control changes how long for. A reverb that does not decay is a resonator.
//   2. ⭐ IT IS DISPERSIVE — the high frequencies arrive BEFORE the low ones. This is the chirp, it is what
//      makes a spring a spring, and the first version of this block FAILED IT while looking completely
//      correct: it measured 0.36 ms in the wrong direction. Nothing but an audio measurement would have said
//      so, which is the entire reason this file exists.
//   3. THE CONTROLS DO WHAT THEY SAY. Mix 0 is a NULL against the input — absent, not merely quiet — and Tone
//      changes the late tail's brightness without changing anything else about it.
//
// Run:  node scripts/spring-check.mjs --plugin <dir with Source/Plugin.cpp>
//       …add --json for the numbers alone, --keep to leave the render behind.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

const ROOT = join(dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const value = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const SR = 48000;
const SECONDS = 6;
const FRAMES = SR * SECONDS;
const IMPULSE_AT = 1.0;   // one second in, so every control has settled out of its smoother before it is played

const pass = [];
const fail = [];
const check = (ok, label, detail) => (ok ? pass : fail).push(detail ? `${label} — ${detail}` : label);

// ── the MRAW container, as the offline host speaks it ───────────────────────────────────────────────────────
function writeMraw(path, channels, frames) {
  const head = Buffer.alloc(20);
  head.write('MRAW', 0, 'ascii');
  head.writeUInt32LE(1, 4);
  head.writeUInt32LE(SR, 8);
  head.writeUInt32LE(channels.length, 12);
  head.writeUInt32LE(frames, 16);
  const body = Buffer.alloc(frames * channels.length * 4);
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels.length; c++) body.writeFloatLE(channels[c][f], (f * channels.length + c) * 4);
  }
  writeFileSync(path, Buffer.concat([head, body]));
}
function readMraw(path) {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'MRAW') throw new Error(`${path} is not MRAW`);
  const chans = buf.readUInt32LE(12);
  const frames = buf.readUInt32LE(16);
  const out = Array.from({ length: chans }, () => new Float64Array(frames));
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < chans; c++) out[c][f] = buf.readFloatLE((f * chans + c) * 4 + 20);
  }
  return out;
}

// ── the measurements ────────────────────────────────────────────────────────────────────────────────────────
/** A one-pole high-pass at `hi` minus a one-pole low-pass at `lo`: a band, without an FFT. */
function band(sig, lowHz, highHz) {
  const out = new Float64Array(sig.length);
  const aHigh = 1 - Math.exp((-2 * Math.PI * highHz) / SR);
  const aLow = 1 - Math.exp((-2 * Math.PI * lowHz) / SR);
  let lp1 = 0;
  let lp2 = 0;
  for (let i = 0; i < sig.length; i++) { lp1 += (sig[i] - lp1) * aHigh; lp2 += (lp1 - lp2) * aLow; out[i] = lp1 - lp2; }
  return out;
}
const energyFrom = (sig, seconds) => {
  let e = 0;
  for (let i = Math.round(seconds * SR); i < sig.length; i++) e += sig[i] * sig[i];
  return e;
};
/** Where a band's energy sits in time, relative to the impulse — the arrival time, not the level. */
const arrivalMs = (sig, fromMs, toMs) => {
  const a = Math.round((IMPULSE_AT + fromMs / 1000) * SR);
  const b = Math.round((IMPULSE_AT + toMs / 1000) * SR);
  let num = 0;
  let den = 0;
  for (let i = a; i < b; i++) { const e = sig[i] * sig[i]; num += e * (i - a); den += e; }
  return den > 0 ? (num / den / SR) * 1000 : NaN;
};
/**
 * T60 from the energy envelope, by least squares between -5 dB and -35 dB.
 *
 * The window is what makes this honest: an envelope fitted from the peak includes the direct chirp, which is
 * not the decay, and one fitted into the noise floor measures the noise. A tail too short to have both ends is
 * reported as NaN rather than as a number nobody should believe.
 */
const t60 = (sig) => {
  const step = Math.round(0.02 * SR);
  const pts = [];
  for (let t = Math.round(IMPULSE_AT * SR); t + step < sig.length; t += step) {
    let s = 0;
    for (let i = t; i < t + step; i++) s += sig[i] * sig[i];
    pts.push([t / SR, 10 * Math.log10(s / step + 1e-30)]);
  }
  if (!pts.length) return NaN;
  const peak = pts.reduce((m, p) => Math.max(m, p[1]), -Infinity);
  const use = pts.filter((p) => p[1] < peak - 5 && p[1] > peak - 35);
  if (use.length < 4) return NaN;
  const n = use.length;
  const mx = use.reduce((a, p) => a + p[0], 0) / n;
  const my = use.reduce((a, p) => a + p[1], 0) / n;
  let num = 0;
  let den = 0;
  for (const [x, y] of use) { num += (x - mx) * (y - my); den += (x - mx) ** 2; }
  const slope = num / den;
  return slope < 0 ? -60 / slope : NaN;
};

// ── build ───────────────────────────────────────────────────────────────────────────────────────────────────
const projectDir = value('--plugin');
if (!projectDir || !existsSync(join(projectDir, 'Source', 'Plugin.cpp'))) {
  console.error('usage: node scripts/spring-check.mjs --plugin <dir with Source/Plugin.cpp> [--json] [--keep]');
  process.exit(2);
}
const work = value('--work') ?? mkdtempSync(join(tmpdir(), 'spring-check-'));
mkdirSync(work, { recursive: true });

const clapInclude = (() => {
  const explicit = value('--clap-include') ?? process.env.CLAP_INCLUDE;
  if (explicit) return explicit;
  const cached = join(ROOT, '.cache', 'clap', 'include');
  if (existsSync(join(cached, 'clap', 'clap.h'))) return cached;
  console.error('no CLAP headers: pass --clap-include <dir> or set CLAP_INCLUDE (the plugin test bench fetches them into .cache/clap).');
  process.exit(2);
})();

const bin = join(work, 'clap_offline');
const hostSrc = join(ROOT, 'tools', 'clap-offline', 'clap_offline.cpp');
const compile = spawnSync(process.env.CXX ?? 'c++', [
  '-std=c++20', '-O2', '-w',
  `-I${clapInclude}`,
  `-I${join(projectDir, 'Source')}`,
  hostSrc,
  join(projectDir, 'Source', 'Plugin.cpp'),
  join(projectDir, 'Source', 'PluginEntry.cpp'),
  '-o', bin,
], { encoding: 'utf8' });
if (compile.status !== 0) {
  console.error(`compilation failed:\n${compile.stderr || compile.stdout}`);
  process.exit(1);
}

// ── render ─────────────────────────────────────────────────────────────────────────────────────────────────
const dry = new Float64Array(FRAMES);
// A single sample, not a burst: the impulse response IS the thing being judged, and any other input asks about
// the input as much as about the reverb.
dry[Math.round(IMPULSE_AT * SR)] = 1.0;
const inPath = join(work, 'impulse.mraw');
writeMraw(inPath, [dry, dry], FRAMES);

const listed = JSON.parse(spawnSync(bin, ['--in', inPath, '--out', join(work, 'x.mraw'), '--list-params'], { encoding: 'utf8' }).stdout);
const params = listed.params || [];
const idOf = (name) => params.find((p) => p.name === name)?.id;
for (const name of ['Decay', 'Tone', 'Mix']) {
  if (idOf(name) == null) {
    console.error(`the plugin reports no "${name}" control. Controls it has: ${params.map((p) => p.name).join(', ')}`);
    process.exit(2);
  }
}

const render = (over = {}) => {
  const argv = ['--in', inPath, '--out', join(work, 'out.mraw'), '--blocksize', '64'];
  for (const [name, v] of Object.entries(over)) argv.push('--param', `${idOf(name)}=${v}`);
  const run = spawnSync(bin, argv, { encoding: 'utf8' });
  if (run.status !== 0) {
    console.error(`the plugin failed to render: ${run.stderr || run.stdout}`);
    process.exit(1);
  }
  // The host reports twice — the descriptor and a timing line — and the LAST one is the timing. (The test
  // bench read the wrong line for a while; see scripts/audio-testbench.mjs.)
  const reports = (run.stdout || '').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return { audio: readMraw(join(work, 'out.mraw'))[0], timing: reports.find((r) => r && r.processSeconds != null) || null };
};

const at = (ms) => Math.round((IMPULSE_AT + ms / 1000) * SR);
const wet = render({ Mix: 100, Decay: 50, Tone: 100 }).audio;
const dryRun = render({ Mix: 0, Decay: 50, Tone: 100 }).audio;
const results = { controls: params.map((p) => `#${p.id} ${p.name}`).join(' · ') };

// 1 ── it decays, and the control moves it
const decays = {};
for (const d of [10, 35, 60, 85, 100]) decays[d] = t60(render({ Mix: 100, Decay: d, Tone: 60 }).audio);
const decayValues = Object.values(decays);
check(decayValues.every((v) => Number.isFinite(v) && v > 0), 'the reverb has a tail that decays', JSON.stringify(decays));
check(decayValues.every((v, i) => i === 0 || v > decayValues[i - 1]), '…and a higher Decay is a longer tail, every step of the way');
check(decayValues[0] < 1.5 && decayValues[decayValues.length - 1] > 2.5, '…across a range a player would use',
  `${decayValues[0].toFixed(2)} s to ${decayValues[decayValues.length - 1].toFixed(2)} s`);
results.t60 = decays;

// 2 ── ⭐ THE CHIRP. This is the claim that makes it a spring, and the one a plausible-looking implementation failed.
const hi = band(wet, 3000, 9000);
const lo = band(wet, 150, 600);
const hiAt = arrivalMs(hi, 0, 40);
const loAt = arrivalMs(lo, 0, 40);
check(loAt > hiAt + 0.5, '⭐ it is DISPERSIVE — the low band arrives after the high band, which is the chirp',
  `high ${hiAt.toFixed(2)} ms, low ${loAt.toFixed(2)} ms, ${(loAt - hiAt).toFixed(2)} ms apart`);
results.dispersionMs = { high: hiAt, low: loAt };

// 3 ── Mix 0 is a null, not a quiet reverb
let nullNum = 0;
let nullDen = 0;
for (let i = 0; i < FRAMES; i++) { const d = dryRun[i] - dry[i]; nullNum += d * d; nullDen += dry[i] * dry[i]; }
const nullDb = 10 * Math.log10(nullNum / nullDen + 1e-30);
check(nullDb < -60, 'Mix 0 is a null against the input — the reverb is absent, not merely quiet', `${nullDb.toFixed(1)} dB`);
results.mixZeroNullDb = nullDb;

// 4 ── Tone changes the LATE tail's brightness and nothing else about it
const brightness = {};
for (const t of [0, 50, 100]) {
  const s = render({ Mix: 100, Tone: t, Decay: 50 }).audio;
  // From 0.5 s in: the FIRST pass through a spring is undamped by design, so a whole-tail measurement would be
  // mostly measuring the direct chirp and would report this control as doing nothing. (It did.)
  brightness[t] = 10 * Math.log10((energyFrom(band(s, 3000, 12000), IMPULSE_AT + 0.5) + 1e-30) / (energyFrom(s, IMPULSE_AT + 0.5) + 1e-30));
}
check(brightness[0] < brightness[50] && brightness[50] < brightness[100],
  'Tone darkens the late tail, monotonically', `3 kHz+ share ${brightness[0].toFixed(1)} / ${brightness[50].toFixed(1)} / ${brightness[100].toFixed(1)} dB`);
check(brightness[100] - brightness[0] > 6, '…by enough to be worth a control', `${(brightness[100] - brightness[0]).toFixed(1)} dB between the ends`);
results.toneBrightnessDb = brightness;

// 5 ── it is not broken audio
check(wet.every((v) => Number.isFinite(v)), 'the output contains no NaN or Inf');
// NOT `Math.max(...arr)`: a 288,000-sample array spread into an argument list is a stack overflow, not a peak.
let peak = 0;
for (let i = 0; i < wet.length; i++) peak = Math.max(peak, Math.abs(wet[i]));
check(peak < 8, 'the output is not running away', `peak ${peak.toFixed(3)}`);

const timing = render({ Mix: 100, Decay: 50, Tone: 60 }).timing;
if (timing && timing.processSeconds && timing.audioSeconds) {
  // the cost of the block, on the machine that ran this
  results.realTimeFactor = timing.audioSeconds / timing.processSeconds;
}

if (flag('--json')) {
  console.log(JSON.stringify({ ...results, pass, fail }, null, 2));
} else {
  console.log(`\nspring reverb — ${params.map((p) => `${p.name}`).join(', ')}\n`);
  console.log('  decay       ' + Object.entries(decays).map(([d, v]) => `${d}%: ${Number.isFinite(v) ? v.toFixed(2) + ' s' : 'too short to fit'}`).join(' · '));
  console.log(`  dispersion  high ${hiAt.toFixed(2)} ms → low ${loAt.toFixed(2)} ms  (${(loAt - hiAt).toFixed(2)} ms apart)`);
  console.log(`  mix 0       ${nullDb.toFixed(1)} dB null against the input`);
  console.log('  tone        ' + Object.entries(brightness).map(([t, v]) => `${t}%: ${v.toFixed(1)} dB`).join(' · ') + '  (3 kHz+ share of the late tail)');
  if (results.realTimeFactor) console.log(`  throughput  ${results.realTimeFactor.toFixed(1)}x real time`);
  console.log('');
  for (const p of pass) console.log(`  PASS  ${p}`);
  for (const f of fail) console.log(`  FAIL  ${f}`);
  console.log(`\n${pass.length}/${pass.length + fail.length} checks passed`);
  if (fail.length) console.log('\nthe spring reverb is not behaving like a spring\n');
}

if (!flag('--keep')) rmSync(work, { recursive: true, force: true });
process.exit(fail.length ? 1 : 0);
