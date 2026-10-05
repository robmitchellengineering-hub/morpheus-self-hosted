// A drive, in the architecture a Klon Centaur is built on — and deliberately NOT called one.
//
// ── THE ARCHITECTURE, AND WHY IT IS WORTH MODELLING RATHER THAN A FUZZ ───────────────────────────────────
// Almost every overdrive is one signal path that gets dirtier as you turn it up: the same signal, harder into
// the same clipper, and the level rises with the gain. The Centaur is famous for doing something else, and the
// something else is three decisions:
//
//   1. A CLEAN PATH AND A CLIPPED PATH, SUMMED. The input is buffered and split. One branch stays clean; the
//      other is driven into the clipper. The Gain control is a DUAL-GANG pot: it raises the drive AND moves
//      the balance between the two, so what a player hears at low settings is mostly their own signal with
//      harmonics arrived underneath it, rather than a distorted copy of it. That is the whole of the word
//      "transparent", and it is why this pedal is imitated rather than the dozens of louder ones.
//   2. GERMANIUM THRESHOLDS, AND TWO DIFFERENT ONES. Germanium diodes conduct at ~0.3 V against silicon's
//      ~0.7 V, so the clipper starts working at a level a guitar actually produces; and the two directions do
//      not match, which is what puts EVEN harmonics in the output. A symmetric clipper makes only odd ones,
//      which is why most distortion sounds like a distortion and this sounds like an amp.
//   3. THE TREBLE CONTROL IS BEFORE THE CLIPPER, not after it. It shapes what the clipper is fed, so it
//      changes the GRAIN of the distortion rather than the brightness of an already-clipped signal. Turn it
//      down and the clipper bites less.
//
// ⚠️ WHAT THIS IS NOT, SAID PLAINLY. It is not a circuit-accurate model of a Centaur, and it is not called
// one. The name is the manufacturer's trademark and the schematic is not ours to claim fidelity to; a claim
// of accuracy would need a reference unit on a bench next to this plugin, and nobody has done that. What is
// modelled is the architecture above, which is public and widely documented, and the measurements in
// `scripts/drive-check.mjs` are what hold the SOUND to account: harmonics that rise with the gain while the
// level stays put, even harmonics present, and a clipper that starts biting at a guitar's own level.
export const DRIVE_MARKER = '__DRIVE_STAGE__';

/** The controls. Keys are prefixed with the block's name because a parameter key is unique across the chain. */
export const DRIVE_PARAMS = [
  { key: 'drive_gain', name: 'Gain', min: 0, max: 100, def: 30, role: 'drive', unit: '%' },
  { key: 'drive_treble', name: 'Treble', min: 0, max: 100, def: 60, role: 'drive', unit: '%' },
  { key: 'drive_level', name: 'Level', min: 0, max: 100, def: 50, role: 'drive', unit: '%' },
];

/**
 * ⚠️ THESE FOUR NUMBERS ARE TUNED AGAINST MEASUREMENTS, NOT PREFERRED, and they are the whole voicing.
 *
 * `DRIVE_MAX` sets how far the clipper is driven at the top of the control; `VF_POS` / `VF_NEG` are the two
 * diode thresholds — germanium, and deliberately unequal, because the asymmetry is where the even harmonics
 * come from; `CLIP_MIX` and `MAKEUP` set how much of the clipped path arrives and at what level, which is the
 * pair that decides the pedal's famous behaviour: **the harmonics rise with the gain while the level does
 * not.** Move any of them and `scripts/drive-check.mjs` says so.
 */
const DRIVE_MAX = 26.0;
const VF_POS = 0.30;
const VF_NEG = 0.46;
const CLIP_MIX = 0.85;
const MAKEUP = 0.18;
/** How far ahead of the clipper the treble control sits: at 0 the clipper is fed a 900 Hz low-pass. */
const TREBLE_HZ = 900.0;

/** The struct and the processing. */
export const driveDspCpp = `// ── the drive ────────────────────────────────────────────────────────────────────────────────────────
// A clean path and a clipped path summed, with unequal germanium thresholds and the tone control BEFORE the
// clipper. See server/src/lib/driveBlock.js for why each of those three is the pedal rather than a detail.
#define MORPHEUS_DRIVE_MAX ${DRIVE_MAX}
#define MORPHEUS_DRIVE_VF_POS ${VF_POS}
#define MORPHEUS_DRIVE_VF_NEG ${VF_NEG}
#define MORPHEUS_DRIVE_CLIP_MIX ${CLIP_MIX}
#define MORPHEUS_DRIVE_MAKEUP ${MAKEUP}
#define MORPHEUS_DRIVE_TREBLE_HZ ${TREBLE_HZ}

typedef struct {
   double toneLp;      // the one-pole the treble control blends against
   double dcX;         // the DC blocker, for the offset an ASYMMETRIC clipper puts on the output
   double dcY;
   double toneLast;
   double toneCoef;
   double gainLast;
   double drive;
   double mix;
} drive_t;

static double drive_process(drive_t *d, double x, double gain01, double treble01, double level, double fs) {
   const double gain = gain01 < 0.0 ? 0.0 : (gain01 > 1.0 ? 1.0 : gain01);
   const double treble = treble01 < 0.0 ? 0.0 : (treble01 > 1.0 ? 1.0 : treble01);

   // TWO CONTROLS, EACH WORTH A TRANSCENDENTAL, AND NEITHER MOVING MOST OF THE TIME. The derivation is the
   // same as the spring reverb's: evaluate when the value has moved by enough to matter, do nothing once a
   // control has settled.
   if (fabs(treble - d->toneLast) > 0.0005) {
      d->toneLast = treble;
      d->toneCoef = 1.0 - exp(-6.283185307179586 * MORPHEUS_DRIVE_TREBLE_HZ / fs);
   }
   if (fabs(gain - d->gainLast) > 0.0005 || d->drive <= 0.0) {
      d->gainLast = gain;
      d->drive = 1.0 + MORPHEUS_DRIVE_MAX * gain;
      // A CURVE RATHER THAN A LINE, because the clipping is already a curve: a linear blend spends its first
      // half doing nothing audible and then arrives all at once. The exponent is what makes the control feel
      // like a gain control across its whole travel.
      d->mix = MORPHEUS_DRIVE_CLIP_MIX * pow(gain, 0.65);
   }

   // 3. THE TREBLE IS BEFORE THE CLIPPER. At 1 it passes the signal whole; at 0 the clipper is fed a 900 Hz
   // low-pass, so the control changes WHAT IS CLIPPED rather than how bright the result is.
   d->toneLp += (x - d->toneLp) * d->toneCoef;
   const double pre = d->toneLp + treble * (x - d->toneLp);

   // 2. TWO DIFFERENT THRESHOLDS. Each direction saturates towards its own diode's drop, which is what makes
   // the transfer curve asymmetric — and an asymmetric curve is the only thing here that can put an even
   // harmonic in the output.
   const double y = pre * d->drive;
   const double c = y >= 0.0
      ? MORPHEUS_DRIVE_VF_POS * tanh(y / MORPHEUS_DRIVE_VF_POS)
      : MORPHEUS_DRIVE_VF_NEG * tanh(y / MORPHEUS_DRIVE_VF_NEG);
   // Normalised so that a fully clipped signal arrives at about unity, whatever the thresholds are.
   const double clipped = c * (2.0 / (MORPHEUS_DRIVE_VF_POS + MORPHEUS_DRIVE_VF_NEG));

   // 1. THE CLEAN PATH AND THE CLIPPED PATH, SUMMED — and the clean path gives way as the gain comes up, so
   // the level holds while the harmonics arrive.
   const double out = x * (1.0 - d->mix) + clipped * (d->mix * MORPHEUS_DRIVE_MAKEUP);

   // THE COUPLING CAP, as one pole. Remove this and the asymmetry above puts a DC offset on the output — a
   // measurable fault, and the reason every real pedal has a capacitor here.
   d->dcY = out - d->dcX + 0.9995 * d->dcY;
   d->dcX = out;
   // Level is a LINEAR output level with unity in the MIDDLE of the control, so a player can always get back
   // to where they started without hunting for a detent.
   return d->dcY * (level * 2.0);
}`;

/** One drive per channel. */
export const driveStateCpp = `   drive_t drive[2];`;

/** No allocation: everything this block holds is nine doubles per channel. */
export const driveInitCpp = `   for (int c = 0; c < 2; ++c) {
      p->drive[c].toneLp = 0.0;
      p->drive[c].dcX = 0.0;
      p->drive[c].dcY = 0.0;
      p->drive[c].toneLast = -1.0;
      p->drive[c].toneCoef = 0.1;
      p->drive[c].gainLast = -1.0;
      p->drive[c].drive = 0.0;
      p->drive[c].mix = 0.0;
   }`;

/** Nothing was allocated, so there is nothing to release — and saying so is shorter than a comment explaining it. */
export const driveDestroyCpp = '';

/** The stage, per channel. */
export const driveStageCpp = `         x = drive_process(&p->drive[c], x,
            p->smoothed[IDX_DRIVE_GAIN] * 0.01, p->smoothed[IDX_DRIVE_TREBLE] * 0.01,
            p->smoothed[IDX_DRIVE_LEVEL] * 0.01, p->fs);`;

export function driveBundle() {
  return {
    dsp: driveDspCpp,
    state: driveStateCpp,
    init: driveInitCpp,
    destroy: driveDestroyCpp,
    markers: { [DRIVE_MARKER]: driveStageCpp },
  };
}
