// The delay: the first block that is not a part of an amp.
//
// ── WHY THIS BLOCK, AND WHY IT IS THE TEST OF THE REGISTRY ────────────────────────────────────────────────
// Everything in `ampChain.js` was written for one signal path — an amp — and the board made that path a list.
// A delay is the cheapest honest proof that the list is real: it is not an amplifier, it does not belong at
// any particular place in the chain, it needs STATE THAT PERSISTS ACROSS SAMPLES, and it needs to allocate.
// If the registry can carry it, the registry is a registry rather than a renaming of the amp chain.
//
// ⚠️ AND IT NEEDS SOMETHING THE OTHERS DID NOT: a place to put its own globals, its own struct in `plugin_t`,
// its own allocation and its own free. The amp chain's blocks are all "read a smoothed parameter and act on
// the sample", which is why `ampChain.js` could own every fragment. This one brings a BUNDLE — see
// `delayBundle()` — and the template interpolates a bundle it is handed rather than knowing what a delay is.
// That indirection is the whole feature: `ampChain.js` still has never heard of a delay.
//
// ── WHAT IT DOES NOT DO, SAID PLAINLY ─────────────────────────────────────────────────────────────────────
// No sync-to-host-tempo (CLAP has a transport event, and reading it is a separate piece of work), no stereo
// ping-pong, no modulation. It is one delay line per channel with feedback and a mix, which is what a player
// means by "a delay", and the controls it does have are the three a player reaches for.

/** The marker the emitted stage uses, so `ampChain.js` can pass it through without knowing what it is. */
export const DELAY_MARKER = '__DELAY_STAGE__';

/**
 * ⚠️ THE BUFFER IS ALLOCATED FOR THE WORST CASE AT `init()`, NOT FOR THE HOST'S SAMPLE RATE AT `activate()`.
 *
 * The delay's buffer size is `time * sample_rate`, and the sample rate is not known until the host activates
 * the plugin. Allocating in `activate()` would be the textbook place — CLAP allows it there and forbids it in
 * `process()` — but `init()` also runs for the offline host, the test bench and anything else that drives the
 * C++ directly, and a buffer that only exists after an activation is a null dereference in a path nobody
 * tests. So the capacity is fixed at 96 kHz for the longest delay, allocated once, and the delay TIME is
 * clamped to what fits. 2 s at 96 kHz is 192,000 floats per channel — 1.5 MB for a stereo plugin, against
 * the 5 MB the model already costs.
 */
export const DELAY_MAX_MS = 2000;
const DELAY_CAPACITY = 192000;   // 2 s at 96 kHz

/** The controls. Keys are prefixed with the block's name because a parameter key is unique across the chain. */
export const DELAY_PARAMS = [
  { key: 'delay_time', name: 'Time', min: 20, max: DELAY_MAX_MS, def: 300, role: 'delay', unit: 'ms' },
  // ⚠️ 95 RATHER THAN 100, and it is not a rounding choice: at 100% every echo returns at exactly the level it
  // left, so the line never decays and a single note becomes a permanent tone. A control whose top position
  // breaks the plugin is a control that should not have that position.
  { key: 'delay_feedback', name: 'Feedback', min: 0, max: 95, def: 30, role: 'delay', unit: '%' },
  { key: 'delay_mix', name: 'Mix', min: 0, max: 100, def: 25, role: 'delay', unit: '%' },
];

/** The struct and the processing. Per channel, like everything else that holds a signal's history. */
export const delayDspCpp = `// ── the delay ────────────────────────────────────────────────────────────────────────────────────────
// A circular buffer per channel. The read pointer is FRACTIONAL and the two neighbouring samples are
// interpolated: the delay time is one of the smoothed parameters, so it glides rather than jumps, and reading
// the nearest whole sample would step the read pointer a sample at a time — which is not a click exactly, but
// it is a grainy artefact on every change, and four lines removes it.
typedef struct { float *buf; int size; int w; double damp; } delay_t;

#define MORPHEUS_DELAY_CAPACITY ${DELAY_CAPACITY}

// A ONE-POLE IN THE FEEDBACK PATH, and it is not decoration: an undamped feedback loop accumulates every
// bit of high end the source has, echo after echo, until it is a whistle rather than a repeat. The time
// constants are not parameters for the same reason the gate's are not — the difference between a delay that
// sounds like a delay and one that sounds like a fault is not a musical choice, and a delay with four
// controls is a delay nobody sets. -3 dB at about 4 kHz.
#define MORPHEUS_DELAY_DAMP 0.55

static double delay_process(delay_t *d, double x, double ms, double feedback, double mix, double fs) {
   if (!d->buf || d->size < 4) return x;
   const double want = ms * 0.001 * fs;
   const double limit = (double)(d->size - 2);
   const double back = want < 1.0 ? 1.0 : (want > limit ? limit : want);
   double r = (double)d->w - back;
   while (r < 0.0) r += (double)d->size;
   const int i0 = (int)r;
   const double frac = r - (double)i0;
   const int i1 = (i0 + 1 >= d->size) ? 0 : i0 + 1;
   const double wet = (double)d->buf[i0] * (1.0 - frac) + (double)d->buf[i1] * frac;
   // THE DAMPING IS IN THE FEEDBACK PATH ONLY, so the first repeat is the signal that was played and the
   // repeats after it darken — which is what a tape delay does and what makes a long feedback usable.
   d->damp += (wet - d->damp) * (1.0 - MORPHEUS_DELAY_DAMP);
   d->buf[d->w] = (float)(x + d->damp * feedback);
   if (++d->w >= d->size) d->w = 0;
   return x * (1.0 - mix) + wet * mix;
}`;

/** One delay line per channel. */
export const delayStateCpp = `   delay_t delay[2];`;

/**
 * Allocate in init(), and FAIL the init rather than run with a broken delay.
 *
 * A plugin that cannot allocate its buffer and carries on is a plugin that outputs the dry signal while its
 * Mix control says otherwise — a wrong sound with no explanation, which is worse than a plugin that refuses
 * to load and says why. Same reasoning as the cabinet's own allocation, a few files over.
 */
export const delayInitCpp = `   for (int c = 0; c < 2; ++c) {
      p->delay[c].size = MORPHEUS_DELAY_CAPACITY;
      p->delay[c].w = 0;
      p->delay[c].damp = 0.0;
      p->delay[c].buf = (float *)calloc((size_t)MORPHEUS_DELAY_CAPACITY, sizeof(float));
      if (!p->delay[c].buf) {
         // NO MACRO AND NO PLUGIN NAME: this fragment is emitted by a module that does not know what the
         // plugin is called, and a message that had to be parameterised for it would be a fragment that
         // cannot be shared. The host's log gets the fact and the size.
         fprintf(stderr, "[morpheus] could not allocate the delay line (%d samples)\\n", MORPHEUS_DELAY_CAPACITY);
         for (int d = 0; d < 2; ++d) { free(p->delay[d].buf); p->delay[d].buf = NULL; }
         return false;
      }
   }`;

/** Release it in destroy(), for the reason the model's pointers are released there: `free` runs no destructors. */
export const delayDestroyCpp = `   for (int c = 0; c < 2; ++c) { free(p->delay[c].buf); p->delay[c].buf = NULL; }`;

/** The stage, per channel — one line, because the work is in the function. */
export const delayStageCpp = `         x = delay_process(&p->delay[c], x,
            p->smoothed[IDX_DELAY_TIME], p->smoothed[IDX_DELAY_FEEDBACK] * 0.01,
            p->smoothed[IDX_DELAY_MIX] * 0.01, p->fs);`;

/**
 * Everything this block contributes to the generated plugin, in one object.
 *
 * `marker` is what the emitted stage text says and `markers` is what it becomes; the four fragments are the
 * file-scope DSP, the state inside `plugin_t`, the allocation in `init()` and the free in `destroy()`. The
 * template interpolates these four and knows nothing else about a delay.
 */
export function delayBundle() {
  return {
    dsp: delayDspCpp,
    state: delayStateCpp,
    init: delayInitCpp,
    destroy: delayDestroyCpp,
    markers: { [DELAY_MARKER]: delayStageCpp },
  };
}
