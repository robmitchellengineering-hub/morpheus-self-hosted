// A spring reverb: a tank of three springs, each a dispersive delay line inside a lossy loop.
//
// ── WHAT A SPRING ACTUALLY DOES, BECAUSE THE MODEL IS THE SOUND ──────────────────────────────────────────
// A spring reverb is a helical spring with a transducer at each end. A click into one does NOT come out as a
// click: it comes out as a descending CHIRP, because a spring is dispersive — the wave speed depends on
// frequency, so the high frequencies arrive first and the low ones trail behind. That chirp, repeated as the
// wave bounces end to end and dulled by the metal's losses, is the character of the thing. A reverb that is
// only a decaying noise tail is a plate, not a spring.
//
// So the model is the two things a spring is:
//
//   • THE DISPERSION is a cascade of Schroeder all-pass sections with different short delays. An impulse into
//     one all-pass comes out as two impulses; into a chain of them it is a weighted train of every
//     subset-sum of the delays — a chirp. This is the standard way to model a spring, and it is standard
//     because it is right rather than because it is cheap.
//   • THE DECAY is a loop around that chain: a loss per round trip, plus a one-pole in the loop for the
//     metal's high-frequency loss. THREE loops at different lengths, because a real tank has two or three
//     springs whose round trips do not coincide — one loop alone flutters audibly, which is a delay rather
//     than a reverb.
//
// ── AND WHAT IT IS NOT, SAID PLAINLY ─────────────────────────────────────────────────────────────────────
// No dwell control (how hard the tank is driven, which on a real amp is a gain into a transformer that
// saturates), no separate low and high damping, and no crash transient. Decay, Tone and Mix are the three a
// player reaches for, and they are the three a measurement can hold to account.
//
// ── ⚠️ WHY THERE IS A COEFFICIENT CACHE IN A REVERB ──────────────────────────────────────────────────────
// `exp()` and `pow()` per sample, to turn two controls into coefficients that have not moved since the last
// sample, is six transcendental calls for nothing — and this block has THREE loops to scale, so it is more
// than six. The tone stack already learned this (MORPHEUS_TONE_EPS in ampChain.js): recompute when the value
// has moved enough to matter, and do nothing at all once a control has settled, which is most of the time and
// all of the time on a Pi.
export const SPRING_MARKER = '__SPRING_STAGE__';

/** The controls. Keys are prefixed with the block's name because a parameter key is unique across the chain. */
export const SPRING_PARAMS = [
  { key: 'spring_decay', name: 'Decay', min: 0, max: 100, def: 50, role: 'spring', unit: '%' },
  { key: 'spring_tone', name: 'Tone', min: 0, max: 100, def: 60, role: 'spring', unit: '%' },
  { key: 'spring_mix', name: 'Mix', min: 0, max: 100, def: 25, role: 'spring', unit: '%' },
];

/**
 * The three round trips and the all-pass delays, in samples AT 48 kHz.
 *
 * ⚠️ THE LENGTHS ARE MUTUALLY INCOMMENSURABLE ON PURPOSE. 1301 / 1997 / 2903 share no common period, so the
 * three springs' chirps do not line up into one louder flutter. The all-pass delays are short and irregular
 * for the same reason: a chain of equal delays is a comb filter, and a comb filter rings.
 */
const LOOP_48 = [1301, 1997, 2903];
const SPRINGS = LOOP_48.length;

/** The worst-case sample rate the buffers are allocated for. Above it the delays are clamped, and said so. */
const MAX_RATE = 96000;
const cap = (at48) => Math.ceil((at48 * MAX_RATE) / 48000) + 2;

/**
 * ⚠️ THE ALL-PASS COEFFICIENT IS FIXED, and that is a decision rather than an omission. It sets how much the
 * chain diffuses: at 0 the chain is a set of pure delays and the reverb rings metallically, and above about
 * 0.75 the chirp smears into a wash that has stopped sounding like a spring at all. 0.62 is where an impulse
 * still READS as a chirp when the response is looked at, which is what the measurement checks.
 */
export const SPRING_AP_G = 0.62;

/**
 * The decay control is a T60 IN SECONDS, not a loop gain, and the difference matters.
 *
 * A loop gain is the loss per round trip, so the same number decays faster through a short spring than a long
 * one — physically right, musically wrong: one Decay control has to mean one decay time for the tank. So each
 * spring's gain is derived from its own round-trip period and the same T60.
 */
const T60_MIN = 0.4;
const T60_MAX = 8.0;

/**
 * ⚠️ THE DISPERSION IS A CHAIN OF FIRST-ORDER ALL-PASS SECTIONS, AND THE FIRST VERSION OF THIS BLOCK GOT IT
 * WRONG IN A WAY ONLY A MEASUREMENT WOULD SHOW.
 *
 * It used Schroeder comb all-passes — the kind a reverb tank's diffusion is usually built from — and measured
 * as a plate: the low band arrived 0.36 ms EARLIER than the high band, i.e. no chirp at all, and in the wrong
 * direction. A comb all-pass's impulse response is a symmetric train of reflections, so its energy arranges
 * itself around the middle of the train rather than sweeping.
 *
 * `H(z) = (a + z^-1) / (1 + a z^-1)` with a NEGATIVE `a` has a group delay of `(1-a)/(1+a)` at DC and
 * `(1+a)/(1-a)` at Nyquist. At a = -0.62 that is 4.3 samples at DC against 0.24 at Nyquist, so the low
 * frequencies are held back and the high ones arrive first — which is the spring's chirp, and the direction a
 * real spring disperses in (the wave speed rises with frequency along a coil).
 *
 * The spread is ~4 ms across ${SECTIONS} sections, and it grows with every round trip because each trip
 * re-disperses what came back. That accumulation is why a spring sounds like a spring rather than like a
 * delay with a filter in it.
 */
export const SPRING_SECTIONS = 56;
const SECTIONS = SPRING_SECTIONS;
const AP_A = -0.62;

/** The structs and the processing. */
export const springDspCpp = `// ── the spring reverb ────────────────────────────────────────────────────────────────────────────────
// Three springs, each a chain of first-order all-pass sections inside a lossy loop. See
// server/src/lib/springBlock.js for why the loop lengths are incommensurable, why the dispersion is this
// chain rather than a Schroeder one, and why two controls are cached rather than evaluated per sample.
#define MORPHEUS_SPRINGS ${SPRINGS}
#define MORPHEUS_SPRING_SECTIONS ${SECTIONS}
// NEGATIVE, and that is the whole of the chirp's direction: at this sign the low frequencies are delayed more
// than the high ones. Flip the sign and the reverb sweeps upward, which no spring does.
#define MORPHEUS_SPRING_AP_A (${AP_A})
#define MORPHEUS_SPRING_MAX_RATE ${MAX_RATE}
#define MORPHEUS_SPRING_T60_MIN ${T60_MIN}
#define MORPHEUS_SPRING_T60_MAX ${T60_MAX}

// ONE SECTION: y[n] = a*x[n] + x[n-1] - a*y[n-1], with the single state the two delayed terms need.
typedef struct { double s; } spring_disp_t;

typedef struct {
   spring_disp_t disp[MORPHEUS_SPRINGS][MORPHEUS_SPRING_SECTIONS];
   float *loop[MORPHEUS_SPRINGS];
   int loopCap[MORPHEUS_SPRINGS];
   int loopW[MORPHEUS_SPRINGS];
   double loopDamp[MORPHEUS_SPRINGS];
   double toneLast;
   double dampCoef;
   double decayLast;
   double gain[MORPHEUS_SPRINGS];
} spring_t;

static double spring_disp(spring_disp_t *d, double x) {
   const double y = MORPHEUS_SPRING_AP_A * x + d->s;
   d->s = x - MORPHEUS_SPRING_AP_A * y;
   return y;
}

// THE ROUND TRIPS AT 48 kHz, scaled by the host's rate at run time so a spring is the same length in
// MILLISECONDS on any machine. A rate above MORPHEUS_SPRING_MAX_RATE shortens the spring rather than reading
// outside a buffer.
static const int kSpringLoop48[MORPHEUS_SPRINGS] = { ${LOOP_48.join(', ')} };
static const int kSpringLoopCap[MORPHEUS_SPRINGS] = { ${LOOP_48.map(cap).join(', ')} };

static int springSamples(int at48, double fs) {
   const double want = (double)at48 * (fs / 48000.0);
   return want < 1.0 ? 1 : (int)(want + 0.5);
}

// HOW MUCH DELAY THE DISPERSION CHAIN ADDS AT DC, in samples — the figure the round-trip PERIOD needs, since
// the decay control is a T60 and a period that ignored the chain would be short by five milliseconds.
#define MORPHEUS_SPRING_DISP_DC ((1.0 - MORPHEUS_SPRING_AP_A) / (1.0 + MORPHEUS_SPRING_AP_A))

static double spring_process(spring_t *s, double x, double decay01, double tone01, double mix, double fs) {
   if (!s->loop[0]) return x;
   const double tone = tone01 < 0.0 ? 0.0 : (tone01 > 1.0 ? 1.0 : tone01);
   const double decay = decay01 < 0.0 ? 0.0 : (decay01 > 1.0 ? 1.0 : decay01);

   // The tone control: 1.2 kHz is a dark spring and 8 kHz a bright one, and the sweep is geometric because
   // pitch is. Recomputing a coefficient that has not moved is six transcendental calls for nothing.
   if (fabs(tone - s->toneLast) > 0.0005) {
      s->toneLast = tone;
      const double hz = 1200.0 * pow(8000.0 / 1200.0, tone);
      s->dampCoef = 1.0 - exp(-6.283185307179586 * hz / fs);
   }

   // The decay control: one T60 for the tank, each spring's loop gain derived from its own period so that one
   // control means one decay time rather than three.
   if (fabs(decay - s->decayLast) > 0.0005 || s->gain[0] <= 0.0) {
      s->decayLast = decay;
      const double t60 = MORPHEUS_SPRING_T60_MIN + (MORPHEUS_SPRING_T60_MAX - MORPHEUS_SPRING_T60_MIN) * decay;
      const double dispPeriod = MORPHEUS_SPRING_SECTIONS * MORPHEUS_SPRING_DISP_DC * (fs / 48000.0);
      for (int i = 0; i < MORPHEUS_SPRINGS; ++i) {
         const double period = ((double)springSamples(kSpringLoop48[i], fs) + dispPeriod) / fs;
         const double g = pow(10.0, -3.0 * period / t60);
         s->gain[i] = g > 0.9995 ? 0.9995 : g;
      }
   }

   double wet = 0.0;
   for (int i = 0; i < MORPHEUS_SPRINGS; ++i) {
      const int len = springSamples(kSpringLoop48[i], fs);
      int r = s->loopW[i] - len;
      if (r < 0) r += s->loopCap[i];
      const double back = (double)s->loop[i][r];
      // THE DAMPING IS IN THE LOOP, so every round trip loses more high end than the one before it — which is
      // what makes a long decay sound like a spring rather than like a feedback loop.
      s->loopDamp[i] += (back - s->loopDamp[i]) * s->dampCoef;
      double v = x + s->loopDamp[i] * s->gain[i];
      for (int k = 0; k < MORPHEUS_SPRING_SECTIONS; ++k) v = spring_disp(&s->disp[i][k], v);
      s->loop[i][s->loopW[i]] = (float)v;
      if (++s->loopW[i] >= s->loopCap[i]) s->loopW[i] = 0;
      wet += v;
   }
   // The three springs sum to roughly three times one spring, so the wet signal is scaled back to the level of
   // ONE spring — a tank with three springs is not three times louder than a tank with one, it is fuller.
   return x * (1.0 - mix) + (wet * (1.0 / MORPHEUS_SPRINGS)) * mix;
}`;

/** One tank per channel. */
export const springStateCpp = `   spring_t spring[2];`;

/** Allocate the three loop delays. There is nothing to allocate for the dispersion: it is 56 doubles. */
export const springInitCpp = `   for (int c = 0; c < 2; ++c) {
      spring_t *s = &p->spring[c];
      s->toneLast = -1.0;
      s->dampCoef = 0.1;
      s->decayLast = -1.0;
      for (int i = 0; i < MORPHEUS_SPRINGS; ++i) { s->gain[i] = 0.0; s->loopDamp[i] = 0.0; }
      for (int i = 0; i < MORPHEUS_SPRINGS; ++i) {
         for (int k = 0; k < MORPHEUS_SPRING_SECTIONS; ++k) s->disp[i][k].s = 0.0;
      }
      int ok = 1;
      for (int i = 0; i < MORPHEUS_SPRINGS; ++i) {
         s->loopCap[i] = kSpringLoopCap[i];
         s->loopW[i] = 0;
         s->loop[i] = (float *)calloc((size_t)kSpringLoopCap[i], sizeof(float));
         if (!s->loop[i]) ok = 0;
      }
      if (!ok) {
         fprintf(stderr, "[morpheus] could not allocate the spring reverb (%d springs, %d samples)\\n",
                 MORPHEUS_SPRINGS, kSpringLoopCap[MORPHEUS_SPRINGS - 1]);
         for (int i = 0; i < MORPHEUS_SPRINGS; ++i) { free(s->loop[i]); s->loop[i] = NULL; }
         return false;
      }
   }`;

/** Release it in destroy(), for the reason the model's pointers are released there: `free` runs no destructors. */
export const springDestroyCpp = `   for (int c = 0; c < 2; ++c) {
      for (int i = 0; i < MORPHEUS_SPRINGS; ++i) { free(p->spring[c].loop[i]); p->spring[c].loop[i] = NULL; }
   }`;

/** The stage, per channel — one call, because the work is in the function. */
export const springStageCpp = `         x = spring_process(&p->spring[c], x,
            p->smoothed[IDX_SPRING_DECAY] * 0.01, p->smoothed[IDX_SPRING_TONE] * 0.01,
            p->smoothed[IDX_SPRING_MIX] * 0.01, p->fs);`;

export function springBundle() {
  return {
    dsp: springDspCpp,
    state: springStateCpp,
    init: springInitCpp,
    destroy: springDestroyCpp,
    markers: { [SPRING_MARKER]: springStageCpp },
  };
}
