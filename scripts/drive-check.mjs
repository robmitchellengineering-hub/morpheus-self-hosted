// Does the drive behave like the pedal whose architecture it is built on — or just like a distortion?
//
// ── THE FOUR QUESTIONS, AND WHY EACH IS THE ONE IT IS ─────────────────────────────────────────────────────
// "It clips" is not a claim worth checking; every overdrive clips. What makes this architecture worth
// modelling, and what a listener recognises, is HOW it clips:
//
//   1. ⭐ THE HARMONICS ARRIVE WHILE THE LEVEL STAYS PUT. This is the whole reputation. A conventional
//      overdrive is one path getting dirtier, so turning the gain up makes it louder and the numbers below
//      would show the level rising by 15-20 dB. The clean/clipped blend is what keeps it inside a couple of
//      dB, and that is measurable to the tenth of a dB.
//   2. THE CLIPPER BITES AT A GUITAR'S OWN LEVEL. Germanium thresholds are ~0.3 V against silicon's ~0.7, so
//      the pedal works at the level an instrument actually produces rather than needing to be driven hard
//      first. Measured by sweeping the INPUT level, not the gain.
//   3. EVEN HARMONICS ARE PRESENT. An odd-symmetric clipper — which is what a pair of matched diodes gives —
//      can only produce odd harmonics. A measurable second harmonic is proof the two diode thresholds differ,
//      and it is why this sounds warmer than a distortion rather than fizzier.
//   4. THE TONE CONTROL IS IN FRONT OF THE CLIPPER. A tone control after a clipper cannot change how hard the
//      clipper worked. Feeding the same tone in dark and bright and measuring different distortion is the
//      experiment that tells the two apart — and a 1 kHz tone is the WRONG test for it, because a 900 Hz
//      corner barely touches it. That mistake is why this tool uses 4 kHz for that one check.
//
// Run:  node scripts/drive-check.mjs --plugin <dir with Source/Plugin.cpp>
//       …add --json for the numbers alone, --keep to leave the renders behind.
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildOfflineHost, clapIncludeDir, dbOf, describePlugin, magnitudeAt, meanOf, render, rmsOf, sineIn, thdOf, writeMraw,
} from './lib/clapOffline.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const value = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const SR = 48000;
const FRAMES = SR * 2;
const SETTLED_AT = SR;          // the measured window: everything from 1 s to 1.5 s
const WINDOW = SR / 2;

const pass = [];
const fail = [];
const check = (ok, label, detail) => (ok ? pass : fail).push(detail ? `${label} — ${detail}` : label);

const projectDir = value('--plugin');
if (!projectDir) {
  console.error('usage: node scripts/drive-check.mjs --plugin <dir with Source/Plugin.cpp> [--json] [--keep]');
  process.exit(2);
}
const work = value('--work') ?? mkdtempSync(join(tmpdir(), 'drive-check-'));
const bin = buildOfflineHost({ projectDir, work, clapInclude: clapIncludeDir(value('--clap-include')) });

// ── the harness ─────────────────────────────────────────────────────────────────────────────────────────────
const inPath = join(work, 'sine.mraw');
const outPath = join(work, 'out.mraw');
// ⚠️ THE HOST HAS TO BE GIVEN A FILE THAT EXISTS to report the plugin's controls — `--list-params` still opens
// the input. Writing it after the descriptor was read reported nothing at all and looked like a broken plugin.
writeMraw(inPath, SR, [sineIn(FRAMES, SR), sineIn(FRAMES, SR)], FRAMES);
const info = describePlugin(bin, inPath);
const idOf = (name) => info.params.find((p) => p.name === name)?.id;
for (const n of ['Gain', 'Treble', 'Level']) {
  if (idOf(n) == null) {
    console.error(`the plugin reports no "${n}" control. It has: ${info.params.map((p) => p.name).join(', ')}`);
    process.exit(2);
  }
}

/** Play a sine at `amplitude` through the drive and return the settled output. */
const play = (over, { hz = 1000, amplitude = 0.2 } = {}) => {
  const sig = sineIn(FRAMES, SR, { hz, amplitude });
  // BOTH CHANNELS, ALWAYS. A one-channel file read back with a two-channel stride doubles the sample rate, and
  // a THD figure above 100% is what that looks like. scripts/lib/clapOffline.mjs reads the header it is given.
  writeMraw(inPath, SR, [sig, sig], FRAMES);
  const params = Object.entries(over).map(([n, v]) => [idOf(n), v]);
  return render(bin, { inPath, outPath, params }).data[0];
};
const thd = (sig, hz = 1000) => thdOf(sig, hz, SR, SETTLED_AT, WINDOW);
const harmonicDb = (sig, k, hz = 1000) => dbOf(magnitudeAt(sig, hz * k, SR, SETTLED_AT, WINDOW) / magnitudeAt(sig, hz, SR, SETTLED_AT, WINDOW));

const results = { controls: info.params.map((p) => `#${p.id} ${p.name}`).join(' · ') };

// 1 ── at zero gain it is not a distortion at all, and it is unity
const clean = play({ Gain: 0, Treble: 60, Level: 50 });
const inputRms = rmsOf(sineIn(FRAMES, SR), SETTLED_AT, WINDOW);
const cleanRms = rmsOf(clean, SETTLED_AT, WINDOW);
check(thd(clean) < 0.005, 'at Gain 0 the output is clean, not a quiet distortion', `THD ${(thd(clean) * 100).toFixed(3)}%`);
check(Math.abs(dbOf(cleanRms / inputRms)) < 0.5, '…and at Level 50 it is unity, so a player can always get back to where they started',
  `${dbOf(cleanRms / inputRms).toFixed(2)} dB`);

// 2 ── ⭐ THE SIGNATURE: harmonics up, level flat
const gains = [0, 20, 40, 60, 80, 100];
const curve = gains.map((g) => {
  const out = play({ Gain: g, Treble: 60, Level: 50 });
  return { gain: g, thd: thd(out), rms: rmsOf(out, SETTLED_AT, WINDOW) };
});
const levelSwing = dbOf(Math.max(...curve.map((c) => c.rms)) / Math.min(...curve.map((c) => c.rms)));
check(curve.every((c, i) => i === 0 || c.thd > curve[i - 1].thd), 'the harmonics rise with Gain, every step of the way',
  curve.map((c) => `${c.gain}%: ${(c.thd * 100).toFixed(1)}%`).join(' · '));
check(curve[curve.length - 1].thd > 0.2, '…and they arrive in earnest', `${(curve[curve.length - 1].thd * 100).toFixed(1)}% at full gain`);
check(levelSwing < 3.0, '⭐ …WHILE THE LEVEL BARELY MOVES — the blend, and the reason this pedal is imitated',
  `${levelSwing.toFixed(2)} dB across the whole range (a single-path overdrive rises 15-20 dB)`);
results.gainCurve = curve.map((c) => ({ gain: c.gain, thdPercent: c.thd * 100, rms: c.rms }));
results.levelSwingDb = levelSwing;

// 3 ── the clipper bites at the level an instrument actually produces
const bites = [0.02, 0.05, 0.1].map((a) => ({ a, thd: thd(play({ Gain: 60, Treble: 60, Level: 50 }, { amplitude: a })) }));
check(bites[1].thd > 0.05, 'the clipper bites at a quiet instrument level, which is what a germanium threshold buys',
  bites.map((b) => `in ${b.a}: ${(b.thd * 100).toFixed(1)}%`).join(' · '));
results.inputSweep = bites;

// 4 ── even harmonics, which an odd-symmetric clipper cannot make
const driven = play({ Gain: 60, Treble: 60, Level: 50 });
const h2 = harmonicDb(driven, 2);
const h3 = harmonicDb(driven, 3);
check(h2 > -50 && h2 < h3, 'even harmonics are present, so the two diode thresholds really are different',
  `2nd ${h2.toFixed(1)} dB, 3rd ${h3.toFixed(1)} dB — a symmetric clipper has no 2nd at all`);
results.harmonicsDb = { second: h2, third: h3 };

// 5 ── the tone control is in FRONT of the clipper, and a 1 kHz tone cannot show it
// ⚠️ 2 kHz, NOT 4, AND AT LOW GAIN, NOT HIGH — two choices that decide whether this check can see anything.
//
// A 900 Hz corner has to actually act on the tone for the control to be visible, and a 1 kHz sine barely
// notices it. But 4 kHz puts its own harmonics above Nyquist, where a DFT stops measuring distortion and starts
// measuring ALIASING. 2 kHz is 7.7 dB down at the corner and keeps eleven harmonics in band.
//
// And at 60% gain the clipper is saturated whatever reaches it, so the control has almost nothing left to
// change (20.6% against 22.1%). At 10% gain the clipper is near its knee, and there the difference is the whole
// point: the same tone fed in dark distorts a quarter as much. A tone control AFTER a clipper cannot do that
// at any gain, which is what makes this the experiment that tells the two apart.
const PRE_HZ = 2000;
const pre = (gain, treble) => thd(play({ Gain: gain, Treble: treble, Level: 50 }, { hz: PRE_HZ }), PRE_HZ);
const preLow = { dark: pre(10, 0), bright: pre(10, 100) };
const preHigh = { dark: pre(60, 0), bright: pre(60, 100) };
check(preLow.dark < preLow.bright * 0.5,
  'the tone control changes how hard the clipper works — so it is in front of it, not after',
  `${PRE_HZ} Hz at 10% gain: THD ${(preLow.dark * 100).toFixed(1)}% with Treble 0 against ${(preLow.bright * 100).toFixed(1)}% with Treble 100`);
results.treblePreClip = { hz: PRE_HZ, lowGain: preLow, highGain: preHigh };

// 6 ── housekeeping the asymmetry would break if the coupling cap were missing
check(Math.abs(meanOf(driven, SETTLED_AT, WINDOW)) < 1e-4, 'no DC offset on the output, which an asymmetric clipper puts there without a coupling capacitor',
  `mean ${meanOf(driven, SETTLED_AT, WINDOW).toExponential(2)}`);
check(driven.every((v) => Number.isFinite(v)), 'the output contains no NaN or Inf');
const timing = render(bin, { inPath, outPath, params: [[idOf('Gain'), 60]] }).timing;
if (timing) results.realTimeFactor = timing.audioSeconds / timing.processSeconds;

if (flag('--json')) {
  console.log(JSON.stringify({ ...results, pass, fail }, null, 2));
} else {
  console.log(`\ndrive — ${info.params.map((p) => p.name).join(', ')}\n`);
  console.log('  gain    ' + curve.map((c) => `${c.gain}%: ${(c.thd * 100).toFixed(1)}% THD, ${c.rms.toFixed(4)} rms`).join(' · '));
  console.log(`  swing   ${levelSwing.toFixed(2)} dB of level across the whole gain range`);
  console.log(`  input   ${bites.map((b) => `${b.a}: ${(b.thd * 100).toFixed(1)}%`).join(' · ')}  (THD against input level at 60% gain)`);
  console.log(`  harmonics  2nd ${h2.toFixed(1)} dB · 3rd ${h3.toFixed(1)} dB`);
  console.log(`  treble     ${PRE_HZ} Hz, Treble 0 against 100 — ${(preLow.dark * 100).toFixed(1)}% against ${(preLow.bright * 100).toFixed(1)}% at 10% gain,`);
  console.log(`             and ${(preHigh.dark * 100).toFixed(1)}% against ${(preHigh.bright * 100).toFixed(1)}% at 60%, where the clipper is saturated either way`);
  if (results.realTimeFactor) console.log(`  throughput ${results.realTimeFactor.toFixed(0)}x real time`);
  console.log('');
  for (const p of pass) console.log(`  PASS  ${p}`);
  for (const f of fail) console.log(`  FAIL  ${f}`);
  console.log(`\n${pass.length}/${pass.length + fail.length} checks passed`);
  if (fail.length) console.log('\nthe drive is not behaving like the architecture it claims\n');
}

if (!flag('--keep')) rmSync(work, { recursive: true, force: true });
process.exit(fail.length ? 1 : 0);
