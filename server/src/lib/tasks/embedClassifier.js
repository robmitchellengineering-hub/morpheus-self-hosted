// EMBED — the stage that turns a container into source the user owns and compiles into their own product.
//
// ── WHY WE EMIT THE FORWARD PASS INSTEAD OF SHIPPING A RUNTIME ────────────────────────────────────────────
// The obvious answer is TFLite: Apache-2.0, small, everywhere. It is the wrong answer here, for the reason the
// plugin pipeline already proves: a model this size is a few hundred lines of arithmetic, and a library is what
// you reach for when you cannot write the arithmetic. Emitted source has no runtime to install, no ABI to match,
// no licence file to carry, no dependency that gets deprecated out from under the user's product — and it is
// theirs, which is the entire promise.
//
// ── ⚠️ WHAT THIS FILE HAS TO GET RIGHT, AND WHY IT IS THE HARDEST IN THE LADDER ────────────────────────────
// The generated C++ recomputes the FEATURES, not just the network. A log-mel spectrogram is: a mono mixdown, a
// resample, a reflect pad, a periodic Hann window, an FFT, a mel filterbank, a log, and a normalisation by the
// clip's own mean and standard deviation — in that order, with the conventions `torch` chose silently. Get one
// of them wrong and the embedded model is worse than the trained one with no error anywhere.
//
// So the generated code is not trusted: `verify-task-ladder.mjs` compiles it, runs it on real audio and compares
// its scores against the JavaScript reader, sample for sample. That comparison is the only reason this stage can
// claim anything at all, and it is why the expensive part of the work is a test rather than a template.
import { frontEndOf, labelsOf, readTower, CLASSIFIER_ARCH } from './classifierModel.js';
import { modelBytes } from '../audio/modelFormat.js';

/** What this stage can emit today. Kept next to the family's own list and checked against it. */
export const EMBED_TARGETS = ['cpp'];

/** The container's integer type at its stored width — the point at which a bit width stops being a number. */
const intType = (bits) => (bits <= 8 ? 'int8_t' : bits <= 16 ? 'int16_t' : 'int32_t');

const num = (x) => {
  // ⚠️ EVERY NUMBER GOES THROUGH HERE, because a generated file that says `NaN` or `1e-7` in an integer array is
  // a file that does not compile — or worse, compiles and computes nonsense. Full precision for the scales (they
  // multiply everything) and integers for the codes.
  if (!Number.isFinite(x)) throw new Error(`refusing to emit a non-finite number (${x}) into source`);
  return Number.isInteger(x) ? String(x) : x.toPrecision(17);
};

const arrayOf = (type, name, values, perLine = 12) => {
  const lines = [];
  for (let i = 0; i < values.length; i += perLine) {
    lines.push('    ' + values.slice(i, i + perLine).map(num).join(', ') + (i + perLine < values.length ? ',' : ''));
  }
  return `static const ${type} ${name}[${values.length}] = {\n${lines.join('\n')}\n};\n`;
};

/**
 * The C++ for one container: a header, the implementation, a small command-line front end and a README.
 *
 * The weights are inlined in the narrowest integer type the container's width needs, so an 8-bit model is an
 * 8-bit array in the source — the byte count in the PACK report is the byte count the compiler emits.
 */
export function cppSource(model, { name = 'morpheus_classifier' } = {}) {
  if (model?.architecture !== CLASSIFIER_ARCH) {
    throw new Error(`this emitter writes ${CLASSIFIER_ARCH} containers, and this one is "${model?.architecture}"`);
  }
  const labels = labelsOf(model);
  const fe = frontEndOf(model);
  const tower = readTower(model);
  const bytes = modelBytes(model);
  // ⚠️ ONE CODE TYPE FOR THE WHOLE FILE, WHICH IS AN INVARIANT WORTH ASSERTING RATHER THAN ASSUMING. The layer
  // table holds one pointer type, so a container whose layers disagree about their width could not be emitted
  // honestly — and a quietly truncated cast is exactly the kind of thing that would be discovered by a customer.
  const widths = [...new Set((model.layers || []).map((l) => l.bits || 32))];
  if (widths.length !== 1) throw new Error(`this emitter writes a container whose layers share one bit width, and these are ${widths.join('/')}`);
  const bits = widths[0];
  const codeType = intType(bits);
  const maxC = Math.max(...tower.map((l) => l.weightShape[0]), labels.length);

  // ── the weights ─────────────────────────────────────────────────────────────────────────────────────────
  const tensors = [];
  const layerLines = [];
  tower.forEach((layer, i) => {
    const raw = (model.layers[i].tensors || []).find((t) => t.name === 'weight');
    const biasRaw = (model.layers[i].tensors || []).find((t) => t.name === 'bias');
    tensors.push(arrayOf(codeType, `L${i}_W`, raw.codes));
    tensors.push(raw.scales ? arrayOf('float', `L${i}_S`, raw.scales, 6) : `static const float L${i}_S[1] = { ${num(raw.scale)} };\n`);
    if (biasRaw) {
      tensors.push(arrayOf(codeType, `L${i}_B`, biasRaw.codes));
      tensors.push(biasRaw.scales ? arrayOf('float', `L${i}_BS`, biasRaw.scales, 6) : `static const float L${i}_BS[1] = { ${num(biasRaw.scale)} };\n`);
    }
    const shape = raw.shape.join(', ');
    const pool = layer.pool === 2 ? 1 : layer.pool === 'avg-all' ? 2 : 0;
    layerLines.push(`    { { ${shape} }, ${raw.block_size || 0}, ${raw.scales ? raw.scales.length : 1}, L${i}_S, L${i}_W, `
      + `${biasRaw ? `L${i}_B` : 'NULL'}, ${biasRaw ? (biasRaw.scales ? biasRaw.scales.length : 1) : 0}, `
      + `${biasRaw ? `L${i}_BS` : 'NULL'}, "${layer.kind}", ${layer.pad}, ${layer.act === 'relu' ? 1 : 0}, ${pool} },`);
  });

  const header = cppHeader(name);
  const impl = cppImpl({ name, labels, fe, layerLines, tensors, bits, bytes, tower, model, maxC, codeType });
  const main = cppMain(name);
  const readme = cppReadme({ name, labels, fe, tower, bits, bytes, model });

  return {
    language: 'cpp',
    files: [
      { path: `${name}.h`, content: header },
      { path: `${name}.c`, content: impl },
      { path: `${name}_main.c`, content: main },
      { path: 'README.md', content: readme },
    ],
    notes: [
      `the weights are ${bits}-bit integers, inlined as ${codeType}`,
      `${bytes.params} weights · ${bytes.total} bytes at rest`,
      'no dependency beyond libm — compile with: cc -O2 *.c -lm',
    ],
  };
}

const cppHeader = (name) => `// ${name} — a Morpheus classifier, as source you own.
//
// Generated by Morpheus. Nothing here links against anything of ours: the model, the front end and the
// arithmetic are all in this file, so what you ship is what you can read.
#ifndef ${name.toUpperCase()}_H
#define ${name.toUpperCase()}_H

#ifdef __cplusplus
extern "C" {
#endif

/** How many labels this model answers. */
int ${name}_label_count(void);

/** The label at an index, or "" if the index is out of range. */
const char *${name}_label(int index);

/**
 * Score one clip. \`samples\` is PCM in [-1, 1] — mono; average the channels yourself if yours is not.
 * \`scores\` must have room for ${name}_label_count() floats, and they sum to 1.
 * Returns the winning index, or -1 if the input is unusable.
 */
int ${name}_classify(const float *samples, int count, int sample_rate, float *scores);

/** The same, reading a 16-bit or 32-bit float WAV. Returns the winning index, or -1. */
int ${name}_classify_wav(const char *path, float *scores);

#ifdef __cplusplus
}
#endif
#endif
`;

/**
 * The implementation.
 *
 * ⚠️ THE FRONT END IS WRITTEN OUT RATHER THAN CALLED, and that is the point of the whole file: every convention
 * that a library would have chosen for us is a line here that can be read. The order is the training project's
 * order, and the numeric types are named at every step so a reader can see where precision is given away.
 */
function cppImpl({ name, labels, fe, layerLines, tensors, bits, bytes, tower, model, maxC, codeType }) {
  const nMels = fe.nMels;
  const nFft = fe.nFft;
  const hop = fe.hop;
  const clip = Math.trunc(fe.sampleRate * fe.clipSeconds);
  const nFreqs = nFft / 2 + 1;
  const frames = model.io?.frames || (1 + Math.floor((clip + (fe.center ? nFft : 0) - nFft) / hop));
  return `// ${name} — the model, the front end and the forward pass. Generated by Morpheus; yours to edit.
//
// ${labels.length} labels · ${tower.length} layers · ${bytes.params} weights at ${bits}-bit · ${bytes.total} bytes at rest.
//
// ── HOW TO READ THIS FILE ────────────────────────────────────────────────────────────────────────────────
// 1. the labels and the front-end constants, which are the ones the model was trained with;
// 2. the weights, as the integers they are stored as, plus the scale(s) that turn them back into numbers;
// 3. the front end: resample → pad → reflect → window → FFT → mel → log → normalise. THE ORDER AND THE
//    CONVENTIONS MATTER MORE THAN ANYTHING ELSE HERE, because getting one wrong makes the model quietly worse;
// 4. the forward pass, which walks the layer table rather than hard-coding a network.
//
// ⚠️ THE SPECTROGRAM IS NORMALISED BY THE CLIP'S OWN MEAN AND STANDARD DEVIATION, so it is a two-pass computation
// over the whole thing. A streaming version that normalises as it goes produces different numbers, which is why
// this file does not pretend to be streaming.
#include "${name}.h"

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// ⚠️ THE CODE TYPE IS THE MODEL'S ACTUAL WIDTH. An 8-bit container becomes an int8_t table, so what the PACK
// report said it would cost is what the compiler actually emits.
typedef ${codeType} code_t;

#define N_MELS ${nMels}
#define N_FFT ${nFft}
#define HOP ${hop}
#define CLIP_SAMPLES ${clip}
#define N_FREQS ${nFreqs}
#define FRAMES ${frames}
#define N_LAYERS ${tower.length}
#define MAX_C ${maxC}

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

// ── the labels, in the order the scores come back ───────────────────────────────────────────────────────────
static const char *const LABELS[] = {
${labels.map((l) => `    ${JSON.stringify(l)},`).join('\n')}
};
static const int LABEL_COUNT = ${labels.length};

// ── the weights ─────────────────────────────────────────────────────────────────────────────────────────────
// ⚠️ STORED AS INTEGERS AT THEIR REAL WIDTH, because that is what a device holds. A code means nothing without its
// scale: value = codes[i] * scales[i / block_size], or * scales[0] when the block size is 0.
${tensors.join('\n')}
typedef struct {
    int shape[4];            // as stored: [out, in, kh, kw] for a conv, [out, in] for a head
    int block_size;          // codes per scale for the weights (0: one scale for the whole tensor)
    int n_scales;
    const float *scales;
    const code_t *codes;
    const code_t *bias;      // NULL when the layer has none
    int n_bias_scales;
    const float *bias_scales;
    const char *kind;        // "conv2d" or "linear"
    int pad;
    int relu;
    int pool;                // 0 none, 1 max over 2x2, 2 average over everything
} Layer;

// ⚠️ THE LAYER TABLE *IS* THE NETWORK. The forward pass walks it, so a different tower is a different table and
// not a different program — and a layer added here without the arithmetic to run it fails at the first call.
static const Layer LAYERS[N_LAYERS] = {
${layerLines.join('\n')}
};

int ${name}_label_count(void) { return LABEL_COUNT; }

const char *${name}_label(int index) {
    if (index < 0 || index >= LABEL_COUNT) return "";
    return LABELS[index];
}

// ── the front end ───────────────────────────────────────────────────────────────────────────────────────────

/** The value a code stands for. One scale per block of codes, or one for the whole tensor when block is 0. */
static double deq(const code_t *codes, const float *scales, int block, int i) {
    return (double)codes[i] * (double)scales[block > 0 ? i / block : 0];
}

/**
 * ⚠️ THE PERIODIC HANN WINDOW, which is what torch.hann_window(n) returns by DEFAULT — and NOT the symmetric
 * 0.5 - 0.5 cos(2 pi i / (n - 1)) form that filter design uses. They differ by a fraction of a percent per bin,
 * every frame, forever, and no error is raised anywhere.
 */
static void hann_window(double *w, int n) {
    for (int i = 0; i < n; i++) w[i] = 0.5 * (1.0 - cos(2.0 * M_PI * (double)i / (double)n));
}

/** Iterative radix-2 Cooley-Tukey. n MUST be a power of two, which the container's n_fft is checked to be. */
static void fft(double *re, double *im, int n) {
    for (int i = 1, j = 0; i < n; i++) {
        int bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            double t = re[i]; re[i] = re[j]; re[j] = t;
            t = im[i]; im[i] = im[j]; im[j] = t;
        }
    }
    for (int len = 2; len <= n; len <<= 1) {
        const double ang = -2.0 * M_PI / (double)len;
        const double wr = cos(ang), wi = sin(ang);
        for (int i = 0; i < n; i += len) {
            double cr = 1.0, ci = 0.0;
            for (int k = 0; k < len / 2; k++) {
                const double ur = re[i + k], ui = im[i + k];
                const double vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
                const double vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
                re[i + k] = ur + vr; im[i + k] = ui + vi;
                re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
                const double nr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = nr;
            }
        }
    }
}

static double dmax(double a, double b) { return a > b ? a : b; }

/**
 * The mel filterbank, REBUILT rather than stored: ${nMels} x ${nFreqs} numbers that are a pure function of four, and a
 * stored copy is a copy that can drift from the one the model was trained with. The HTK formula, as in training.
 */
static void mel_filterbank(double *fb) {
    const double fmin = ${num(fe.fmin)}, fmax = ${num(fe.sampleRate / 2)};
    const double mel_lo = 2595.0 * log10(1.0 + fmin / 700.0);
    const double mel_hi = 2595.0 * log10(1.0 + fmax / 700.0);
    double points[N_MELS + 2];
    for (int i = 0; i < N_MELS + 2; i++) {
        const double m = mel_lo + (mel_hi - mel_lo) * (double)i / (double)(N_MELS + 1);
        points[i] = 700.0 * (pow(10.0, m / 2595.0) - 1.0);
    }
    for (int i = 0; i < N_MELS; i++) {
        for (int k = 0; k < N_FREQS; k++) {
            const double f = fmax * (double)k / (double)(N_FREQS - 1);
            const double rising = (f - points[i]) / dmax(points[i + 1] - points[i], 1e-9);
            const double falling = (points[i + 2] - f) / dmax(points[i + 2] - points[i + 1], 1e-9);
            const double v = rising < falling ? rising : falling;
            fb[i * N_FREQS + k] = v > 0.0 ? v : 0.0;
        }
    }
}

/**
 * The log-mel spectrogram: resample, pad, reflect, window, FFT, mel, log, then normalise over everything.
 *
 * ⚠️ THE REFLECT PAD IS torch.stft's center=True, pad_mode='reflect', and it is why ${frames} frames come out of
 * ${clip} samples. A zero pad here would change every frame's edges — and the count.
 */
static void log_mel(const float *samples, int count, int sample_rate, double *out) {
    static double wave[CLIP_SAMPLES];
    static double xs[CLIP_SAMPLES + N_FFT];
    static double re[N_FFT], im[N_FFT], win[N_FFT], fb[N_MELS * N_FREQS];
    static double spec[N_FREQS * FRAMES];

    // 1. resample by truncating the index — the same arithmetic as torch.linspace(...).long() in training.
    if (sample_rate != ${fe.sampleRate} && sample_rate > 0) {
        const int steps = (int)((double)count * (double)${fe.sampleRate} / (double)sample_rate);
        const double step = steps > 1 ? (double)(count - 1) / (double)(steps - 1) : 0.0;
        for (int i = 0; i < CLIP_SAMPLES; i++) {
            const int at = (int)((double)i * step);
            wave[i] = (i < steps && at >= 0 && at < count) ? (double)samples[at] : 0.0;
        }
    } else {
        for (int i = 0; i < CLIP_SAMPLES; i++) wave[i] = i < count ? (double)samples[i] : 0.0;
    }

    // 2. reflect at both ends by N_FFT/2, then frame.
    const int pad = N_FFT / 2;
    for (int i = 0; i < pad; i++) xs[i] = wave[pad - i];
    for (int i = 0; i < CLIP_SAMPLES; i++) xs[pad + i] = wave[i];
    for (int i = 0; i < pad; i++) xs[pad + CLIP_SAMPLES + i] = wave[CLIP_SAMPLES - 2 - i];

    hann_window(win, N_FFT);
    mel_filterbank(fb);

    // 3. window, FFT, magnitude, mel, log.
    for (int f = 0; f < FRAMES; f++) {
        const int at = f * HOP;
        for (int i = 0; i < N_FFT; i++) { re[i] = xs[at + i] * win[i]; im[i] = 0.0; }
        fft(re, im, N_FFT);
        for (int k = 0; k < N_FREQS; k++) spec[k * FRAMES + f] = sqrt(re[k] * re[k] + im[k] * im[k]);
    }
    for (int m = 0; m < N_MELS; m++) {
        for (int f = 0; f < FRAMES; f++) {
            double sum = 0.0;
            for (int k = 0; k < N_FREQS; k++) sum += fb[m * N_FREQS + k] * spec[k * FRAMES + f];
            out[m * FRAMES + f] = log(sum + ${num(fe.logEps)});
        }
    }

    // 4. ⚠️ NORMALISE BY THE CLIP'S OWN MEAN AND STANDARD DEVIATION — the UNBIASED one, N-1, which is what torch's
    // Tensor.std() uses. A clip's loudness therefore cancels out, and a streaming version cannot do this.
    const int total = N_MELS * FRAMES;
    double mean = 0.0;
    for (int i = 0; i < total; i++) mean += out[i];
    mean /= (double)total;
    double ss = 0.0;
    for (int i = 0; i < total; i++) { const double d = out[i] - mean; ss += d * d; }
    const double sd = sqrt(ss / (double)(total - 1));
    for (int i = 0; i < total; i++) out[i] = (out[i] - mean) / (sd + 1e-5);
}

// ── the forward pass ────────────────────────────────────────────────────────────────────────────────────────

int ${name}_classify(const float *samples, int count, int sample_rate, float *scores) {
    if (!samples || !scores || count <= 0) return -1;
    static double feat[N_MELS * FRAMES];
    static double a[MAX_C * N_MELS * FRAMES];
    static double b[MAX_C * N_MELS * FRAMES];
    static double flat[MAX_C * N_MELS * FRAMES];

    log_mel(samples, count, sample_rate, feat);
    memcpy(a, feat, sizeof(double) * N_MELS * FRAMES);

    int C = 1, H = N_MELS, W = FRAMES;
    int flat_n = 0;
    memset(flat, 0, sizeof(double) * MAX_C);

    for (int li = 0; li < N_LAYERS; li++) {
        const Layer *l = &LAYERS[li];
        if (l->kind[0] == 'c') {
            const int OC = l->shape[0], IC = l->shape[1], KH = l->shape[2], KW = l->shape[3];
            const int oh = H + 2 * l->pad - KH + 1;
            const int ow = W + 2 * l->pad - KW + 1;
            if (oh <= 0 || ow <= 0 || OC > MAX_C) return -1;
            for (int oc = 0; oc < OC; oc++) {
                const double bias = l->bias ? deq(l->bias, l->bias_scales, 0, oc) : 0.0;
                for (int y = 0; y < oh; y++) {
                    for (int x = 0; x < ow; x++) {
                        double sum = bias;
                        for (int ic = 0; ic < IC; ic++) {
                            for (int ky = 0; ky < KH; ky++) {
                                const int iy = y + ky - l->pad;
                                if (iy < 0 || iy >= H) continue;
                                for (int kx = 0; kx < KW; kx++) {
                                    const int ix = x + kx - l->pad;
                                    if (ix < 0 || ix >= W) continue;
                                    const int wi = ((oc * IC + ic) * KH + ky) * KW + kx;
                                    sum += deq(l->codes, l->scales, l->block_size, wi) * a[(ic * H + iy) * W + ix];
                                }
                            }
                        }
                        if (l->relu && sum < 0.0) sum = 0.0;
                        b[(oc * oh + y) * ow + x] = sum;
                    }
                }
            }
            C = OC; H = oh; W = ow;
            memcpy(a, b, sizeof(double) * C * H * W);
            flat_n = 0;
            if (l->pool == 1) {
                const int ph = H / 2, pw = W / 2;
                for (int c = 0; c < C; c++) {
                    for (int y = 0; y < ph; y++) {
                        for (int x = 0; x < pw; x++) {
                            double m = -1e30;
                            for (int dy = 0; dy < 2; dy++) {
                                for (int dx = 0; dx < 2; dx++) {
                                    const double v = a[(c * H + (2 * y + dy)) * W + (2 * x + dx)];
                                    if (v > m) m = v;
                                }
                            }
                            b[(c * ph + y) * pw + x] = m;
                        }
                    }
                }
                H = ph; W = pw;
                memcpy(a, b, sizeof(double) * C * H * W);
            } else if (l->pool == 2) {
                for (int c = 0; c < C; c++) {
                    double sum = 0.0;
                    for (int i = 0; i < H * W; i++) sum += a[c * H * W + i];
                    flat[c] = sum / (double)(H * W);
                }
                flat_n = C;
            }
        } else {
            const int OC = l->shape[0], IC = l->shape[1];
            const double *vec = flat_n ? flat : a;
            const int vn = flat_n ? flat_n : C * H * W;
            if (IC != vn || OC > MAX_C) return -1;
            for (int oc = 0; oc < OC; oc++) {
                double sum = l->bias ? deq(l->bias, l->bias_scales, 0, oc) : 0.0;
                for (int i = 0; i < IC; i++) {
                    const int wi = oc * IC + i;
                    sum += deq(l->codes, l->scales, l->block_size, wi) * vec[i];
                }
                b[oc] = sum;
            }
            flat_n = OC;
            memcpy(flat, b, sizeof(double) * OC);
        }
    }

    if (flat_n <= 0 || flat_n != LABEL_COUNT) return -1;
    // Softmax, shifted by the maximum so a large logit cannot overflow it.
    double m = flat[0];
    for (int i = 1; i < flat_n; i++) if (flat[i] > m) m = flat[i];
    double sum = 0.0;
    for (int i = 0; i < flat_n; i++) { flat[i] = exp(flat[i] - m); sum += flat[i]; }
    int best = 0;
    for (int i = 0; i < flat_n; i++) {
        scores[i] = (float)(flat[i] / sum);
        if (scores[i] > scores[best]) best = i;
    }
    return best;
}
`;
}

const cppMain = (name) => `// A command-line front end, so the model can be tried before it is wired into anything.
//
//     cc -O2 ${name}.c ${name}_main.c -lm -o ${name}_demo
//     ./${name}_demo clip.wav
#include "${name}.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/** A WAV reader for the two formats a recording is actually in: 16-bit PCM and 32-bit float. */
static float *read_wav(const char *path, int *frames_out, int *rate_out) {
    FILE *f = fopen(path, "rb");
    if (!f) { fprintf(stderr, "cannot open %s\\n", path); return NULL; }
    char id[4];
    uint32_t size;
    if (fread(id, 1, 4, f) != 4 || memcmp(id, "RIFF", 4) || fseek(f, 4, SEEK_CUR) || fread(id, 1, 4, f) != 4
        || memcmp(id, "WAVE", 4)) {
        fprintf(stderr, "%s is not a RIFF/WAVE file\\n", path);
        fclose(f);
        return NULL;
    }
    int channels = 0, bits = 0, format = 0, rate = 0;
    uint32_t data_bytes = 0;
    long data_at = 0;
    while (fread(id, 1, 4, f) == 4 && fread(&size, 4, 1, f) == 1) {
        if (!memcmp(id, "fmt ", 4)) {
            /* ⚠️ THE LAYOUT, IN 16-BIT WORDS: format, channels, rate(4 bytes = 2 words), byte rate(2 words),
               block align, bits. 'bits' IS v[7] -- reading v[6] gives the block align, which for 16-bit stereo
               4, and then the frame count below divides by zero. */
            uint16_t v[8];
            const size_t got = fread(v, 2, 8, f);
            if (got < 8) break;
            format = v[0];
            channels = v[1];
            rate = (int)(v[2] | ((uint32_t)v[3] << 16));
            bits = v[7];
            if (size > 16) fseek(f, (long)size - 16, SEEK_CUR);
        } else if (!memcmp(id, "data", 4)) {
            data_bytes = size;
            data_at = ftell(f);
            fseek(f, (long)size + (size & 1), SEEK_CUR);
        } else {
            fseek(f, (long)size + (size & 1), SEEK_CUR);
        }
    }
    if (!channels || !data_at) { fprintf(stderr, "%s has no fmt or data chunk\\n", path); fclose(f); return NULL; }
    const int bytes = bits / 8;
    if (bytes <= 0 || channels <= 0 || !data_bytes) {
        fprintf(stderr, "%s: %d-bit, %d channels -- this reader handles 16-bit PCM and 32-bit float\\n", path, bits, channels);
        fclose(f);
        return NULL;
    }
    const int frames = (int)(data_bytes / (uint32_t)(bytes * channels));
    unsigned char *raw = (unsigned char *)malloc(data_bytes);
    if (!raw) { fclose(f); return NULL; }
    fseek(f, data_at, SEEK_SET);
    if (fread(raw, 1, data_bytes, f) != data_bytes) { free(raw); fclose(f); return NULL; }
    fclose(f);
    float *out = (float *)malloc(sizeof(float) * (size_t)frames);
    for (int i = 0; i < frames; i++) {
        double acc = 0.0;
        for (int c = 0; c < channels; c++) {
            const long at = (long)(i * channels + c) * bytes;
            if (format == 3 && bits == 32) { float v; memcpy(&v, raw + at, 4); acc += v; }
            else if (bits == 16) { int16_t v; memcpy(&v, raw + at, 2); acc += (double)v / 32767.0; }
            else { acc += 0.0; }
        }
        out[i] = (float)(acc / channels);   // ⚠️ THE MIXDOWN, averaged — the training project's mean(axis=1)
    }
    free(raw);
    *frames_out = frames;
    *rate_out = rate;
    return out;
}

int ${name}_classify_wav(const char *path, float *scores) {
    int frames = 0, rate = 0;
    float *samples = read_wav(path, &frames, &rate);
    if (!samples) return -1;
    const int best = ${name}_classify(samples, frames, rate, scores);
    free(samples);
    return best;
}

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: %s <clip.wav>\\n", argv[0]); return 2; }
    const int n = ${name}_label_count();
    float *scores = (float *)calloc((size_t)n, sizeof(float));
    const int best = ${name}_classify_wav(argv[1], scores);
    if (best < 0) { free(scores); return 1; }
    printf("%s\\n", ${name}_label(best));
    for (int i = 0; i < n; i++) printf("  %-16s %.6f\\n", ${name}_label(i), (double)scores[i]);
    free(scores);
    return 0;
}
`;

const cppReadme = ({ name, labels, fe, tower, bits, bytes, model }) => `# ${name} — a classifier you own

Generated by Morpheus from a \`${model.format}\` container. **There is no dependency on Morpheus here and no
runtime to install**: the couple of hundred lines beside this file are the whole thing.

- **${labels.length} labels**: ${labels.join(', ')}
- **${bytes.params} weights at ${bits}-bit**, ${bytes.total} bytes at rest (${bytes.weights} weights + ${bytes.scales} scales)
- **${tower.length} layers**, walked from a table rather than hard-coded
- **the front end is included**: a mono clip at any rate, resampled to ${fe.sampleRate} Hz, ${fe.clipSeconds} s of
  it, log-mel over ${fe.nMels} mel bins (n_fft ${fe.nFft}, hop ${fe.hop}), normalised per clip

## Build

\`\`\`
cc -O2 ${name}.c ${name}_main.c -lm -o ${name}_demo
./${name}_demo clip.wav
\`\`\`

## Use it

\`\`\`c
#include "${name}.h"

float scores[${labels.length}];
int best = ${name}_classify(samples, count, sample_rate, scores);
printf("%s\\n", ${name}_label(best));
\`\`\`

\`samples\` is PCM in [-1, 1] and **mono** — if yours is stereo, average the channels first, because that is what the
model was trained on. \`scores\` sums to 1.

## Editing it

The layer table is the network. Its \`shape\`, \`pad\`, \`relu\` and \`pool\` fields are what the forward pass reads, so
a change there is a change of architecture and needs matching arithmetic. The weights are stored as integers with
one scale per output channel (\`block_size\` codes per scale), which is what makes a narrow bit width affordable —
one channel's range does not set the grid for every other channel's.

⚠️ **If you change the front end, the model is no longer the model that was measured.** The window convention, the
reflect padding and the per-clip normalisation are all load-bearing; Morpheus's own verification compiles this
directory and compares its scores against its reader, and that is the check that would fail.
`;
