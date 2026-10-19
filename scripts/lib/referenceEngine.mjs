// The reference engine: find it, build it once, render a model through it.
//
// WHY THIS IS A MODULE. `scripts/audio-quantize.mjs` had these inlined, and the capture work needs the same
// thing — the same clone, the same pin, the same one-time build, the same "the engine failed" message. Two
// copies would be two pins to keep in step, and this repository has already paid once for a second
// implementation of something that had a reference.
//
// THE PIN IS THE SAME COMMIT THE PLUGIN USES (`lib/namPlugin.js`'s NAMCORE_REF). That is not tidiness: the
// plugin and every measurement here have to be the same code, or a difference in the output is two engines
// disagreeing rather than a bug in either.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeWav } from '../../server/src/lib/audio/wav.js';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const NAMCORE_REPO = 'https://github.com/sdatkinson/NeuralAmpModelerCore.git';
export const NAMCORE_REF = '0b3d3c9'; // pinned: the engine core and its example models, as measured
export const NAMCORE_DIR = join(ROOT, '.cache', 'namcore');

/**
 * The reference renderer, built once into `.cache`.
 *
 * Pinned, so "it worked yesterday" means something, and cached, because building it takes minutes. `explicit`
 * wins over everything: a caller that has one already, or a machine without cmake, should not be forced
 * through a clone.
 */
export function ensureEngine({ explicit = null, quiet = false } = {}) {
  const given = explicit ?? process.env.NAMCORE_RENDER;
  if (given) {
    if (!existsSync(given)) { console.error(`the renderer ${given} does not exist`); process.exit(2); }
    return given;
  }
  const cached = join(NAMCORE_DIR, 'build', 'tools', 'render');
  if (existsSync(cached)) return cached;

  const cmake = process.env.CMAKE ?? 'cmake';
  const has = spawnSync(cmake, ['--version'], { encoding: 'utf8' }).status === 0;
  if (!has) {
    console.error(`the reference engine is not built and cmake is not on PATH.\n`
      + `  Either pass --render <path-to-render>, or install cmake and re-run (it will fetch and build\n`
      + `  NeuralAmpModelerCore ${NAMCORE_REF} into .cache/namcore once).`);
    process.exit(2);
  }
  if (!quiet) console.log(`fetching and building the reference engine (NeuralAmpModelerCore ${NAMCORE_REF}) — one time …`);
  mkdirSync(dirname(NAMCORE_DIR), { recursive: true });
  try {
    if (!existsSync(join(NAMCORE_DIR, 'CMakeLists.txt'))) {
      execFileSync('git', ['clone', '--quiet', NAMCORE_REPO, NAMCORE_DIR], { stdio: quiet ? 'ignore' : 'inherit' });
    }
    execFileSync('git', ['-C', NAMCORE_DIR, 'checkout', '--quiet', NAMCORE_REF], { stdio: quiet ? 'ignore' : 'inherit' });
    execFileSync('git', ['-C', NAMCORE_DIR, 'submodule', 'update', '--init', '--depth', '1'], { stdio: quiet ? 'ignore' : 'inherit' });
    mkdirSync(join(NAMCORE_DIR, 'build'), { recursive: true });
    const stdio = quiet ? 'ignore' : 'inherit';
    execFileSync(cmake, ['..', '-DCMAKE_BUILD_TYPE=Release'], { cwd: join(NAMCORE_DIR, 'build'), stdio });
    execFileSync(cmake, ['--build', '.', '--target', 'render', '-j4'], { cwd: join(NAMCORE_DIR, 'build'), stdio });
  } catch {
    console.error(`could not build the reference engine. Clone it yourself and pass --render <path>:\n`
      + `  git clone ${NAMCORE_REPO} .cache/namcore && cd .cache/namcore && git checkout ${NAMCORE_REF}\n`
      + `  git submodule update --init --depth 1 && cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build --target render`);
    process.exit(2);
  }
  if (!existsSync(cached)) { console.error('the build finished but tools/render is not where it should be'); process.exit(2); }
  return cached;
}

/**
 * Render a model over a WAV file and return the samples.
 *
 * The engine's own `render` tool: mono in, mono out, and it refuses a sample rate the model was not trained
 * at. That refusal is the point — a capture checked at the wrong rate would otherwise measure a resampling
 * artefact and report it as the model.
 */
export function renderThroughFile(engine, modelPath, inPath, outPath) {
  const run = spawnSync(engine, [modelPath, inPath, outPath], { encoding: 'utf8' });
  if (run.status !== 0) {
    console.error(`the reference engine failed on ${modelPath}:\n${(run.stderr || run.stdout || '').slice(-2000)}`);
    process.exit(1);
  }
  return decodeWav(readFileSync(outPath)).data[0];
}
