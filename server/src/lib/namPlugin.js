// Bake a `.nam` model into the generated plugin.
//
// WHY THIS IS ITS OWN MODULE. `audioPluginProject.js` decides what a plugin project looks like;
// `audioPluginTemplate.js` holds the source text. Embedding a model is a third job — find the model, check it
// is one, and turn it into a C++ translation unit — and it is the one part that has to know anything about
// the `.nam` format. Keeping it here means the other two stay readable, both stay pure (no fs, no imports
// beyond each other), and `verify-audio-plugin.mjs` can exercise all of it in CI's no-install job.
//
// ── THE ENGINE IS NOT OURS. AGAIN. ───────────────────────────────────────────────────────────────────────
// `lib/audio/namModel.js` already refused to hand-port NAM's weight layout for MEASUREMENT, on the grounds
// that NeuralAmpModelerCore is MIT, maintained, and IS the reference. The same argument decides this file:
// the plugin calls `nam::get_dsp(json)` and `nam::DSP::process()` from that same library rather than growing
// a second implementation of WaveNet that nobody could ever prove correct. What is OURS is the part nobody
// has: the model as a file in the user's project, the artifact the build produces, and the automation that
// puts them together.
//
// ── WHY THE MODEL IS A PROJECT FILE RATHER THAN A BLOB IN THIS GENERATOR ──────────────────────────────────
// The model is emitted into `Source/ModelData.cpp` as bytes, but the file the user owns is the `.nam` — the
// same file the training tool wrote, sitting in their project, readable, replaceable and diffable. The
// generated `.cpp` says in its own header that it is derived and will be rewritten, so nobody edits it twice.
//
// ── NO MODEL IS A SUPPORTED STATE, NOT AN ERROR ──────────────────────────────────────────────────────────
// A project with no `.nam` scaffolds exactly the plugin it scaffolded before this existed (a stereo gain
// stage). That is deliberate: it keeps every existing proof — the three runner builds, the test bench, the
// measured gain of +5.92 dB — valid and unchanged, and it means a model is an upgrade rather than a
// prerequisite.

/** Where a model usually lives. Not required: any `.nam` in the project will do. */
export const MODEL_DIR = 'models';

/** The generated pair. `ModelData.cpp` is derived; `ModelData.h` is what makes the plugin compile either way. */
export const MODEL_DATA_SOURCE = 'Source/ModelData.cpp';
export const MODEL_DATA_HEADER = 'Source/ModelData.h';

/** The `.nam` field names this reads. Kept in one place so the C++ side cannot disagree with the JS side. */
const MODEL_FIELDS = ['architecture', 'config', 'weights', 'sample_rate'];

/**
 * The neural engine's own pin. It lives here rather than beside CLAP_WRAPPER_REF because this is the module
 * that knows what a model is, and the two modules would otherwise import each other in a cycle.
 *
 * PINNED TO THE SAME COMMIT THE MEASUREMENT CLI BUILDS (`scripts/audio-quantize.mjs`, NAMCORE_REF) and that
 * is deliberate: the CLI renders the reference WAV and the plugin plays the model through the same code. If
 * those pins ever drift, the offline comparison that proves the plugin is comparing two implementations, and
 * a difference in the output would be a difference between two engines rather than a bug in ours.
 */
export const NAMCORE_REPO = 'https://github.com/sdatkinson/NeuralAmpModelerCore.git';
export const NAMCORE_REF = '0b3d3c9';

/**
 * The `.nam` this project carries, or null.
 *
 * `morpheus.plugin.json` may name one explicitly (`"model": "models/marshall.nam"`); otherwise the project is
 * searched, with `models/` preferred and then the shallowest path, and the alphabetically first of those. The
 * ordering is fixed rather than "whatever the files array happened to hold", because a project with two
 * models must build the same plugin twice.
 */
export function findModelPath(files, manifest = {}) {
  const named = typeof manifest.model === 'string' ? manifest.model.trim() : '';
  if (named) return hasModel(files, named) ? named : null;

  const candidates = (Array.isArray(files) ? files : [])
    .filter((f) => f && typeof f.path === 'string' && /\.nam$/i.test(f.path) && String(f.content || '').trim())
    .map((f) => f.path)
    .sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  return candidates[0] || null;
}

const hasModel = (files, path) => (Array.isArray(files) ? files : [])
  .some((f) => f && f.path === path && String(f.content || '').trim());

// `models/` first, then by depth, so `models/amp.nam` beats `src/old/amp.nam` every time.
function rank(path) {
  const depth = path.split('/').length;
  return (/^models\//i.test(path) ? 0 : 100) + depth;
}

/**
 * Check a `.nam` without a full parse, and say what is wrong with it in words a user can act on.
 *
 * Deliberately NOT `parseNam` from `lib/audio/namModel.js`: that one materialises every weight into a
 * `Float64Array` to quantize it, which for a 400 KB model is tens of thousands of doubles that this path has
 * no use for. The validation that matters here is the same shape though — the file has to be JSON, it has to
 * have an architecture, and its weights have to be real numbers.
 */
export function inspectModel(text) {
  let raw;
  try { raw = JSON.parse(text); } catch (err) {
    return { ok: false, reason: `not valid JSON (${String(err.message).split('\n')[0].slice(0, 120)})` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'not a JSON object' };
  if (!raw.architecture) return { ok: false, reason: 'has no "architecture" field' };
  if (!Array.isArray(raw.weights) || raw.weights.length === 0) return { ok: false, reason: 'has no "weights" array' };
  // The RAW values, for the reason `parseNam` documents: `Float64Array.from([1, null])` is `[1, 0]`, so a
  // null quietly becomes a plausible weight and the plugin loads a model that was never trained.
  const bad = raw.weights.findIndex((w) => typeof w !== 'number' || !Number.isFinite(w));
  if (bad !== -1) return { ok: false, reason: `weight ${bad} is not a finite number` };
  return {
    ok: true,
    architecture: String(raw.architecture),
    version: raw.version == null ? null : String(raw.version),
    sampleRate: typeof raw.sample_rate === 'number' ? raw.sample_rate : null,
    weights: raw.weights.length,
    missing: MODEL_FIELDS.filter((k) => raw[k] === undefined),
    bytes: Buffer.byteLength(text, 'utf8'),
  };
}

/** A C string literal for a value that may contain anything. Only used for the identifying fields. */
const cString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * `Source/ModelData.h` — written whether or not there is a model.
 *
 * THIS IS THE POINT OF THE PAIR. `Source/Plugin.cpp` includes this header unconditionally and branches on
 * `MORPHEUS_HAS_MODEL`, so the plugin source is byte-identical with a model and without one. That is not
 * tidiness: the test bench patches `Plugin.cpp` to prove it can fail, and a file whose text changed shape
 * depending on whether a model was present would make that patch, and the proof, depend on the workspace.
 */
export function modelHeader(info) {
  if (!info) {
    return `// Generated by Morpheus — this project has no .nam model.
//
// It exists so that Source/Plugin.cpp can include it unconditionally. Add a .nam to the project (models/
// is the conventional place, or name one in morpheus.plugin.json as "model") and rebuild: this header is
// regenerated, MORPHEUS_HAS_MODEL becomes 1, and the plugin runs the model instead of a bare gain stage.
#pragma once
#define MORPHEUS_HAS_MODEL 0
`;
  }
  return `// Generated by Morpheus from ${info.path} — do not edit; it is rewritten on every build.
//
// The plugin includes this and branches on MORPHEUS_HAS_MODEL, so it compiles with or without a model.
#pragma once
#define MORPHEUS_HAS_MODEL 1
#define MORPHEUS_MODEL_PATH ${cString(info.path)}
#define MORPHEUS_MODEL_NAME ${cString(info.name)}
#define MORPHEUS_MODEL_ARCHITECTURE ${cString(info.architecture)}
#define MORPHEUS_MODEL_WEIGHTS ${info.weights}
#define MORPHEUS_MODEL_BYTES ${info.bytes}

// The bytes live in ModelData.cpp. Declared here because the plugin uses them and only the DEFINITION is in
// the other translation unit — the first version of this header defined the macros and not the symbols, and
// the compiler said so immediately.
extern const unsigned char morpheus_model_data[];
extern const unsigned long morpheus_model_size;
`;
}

/**
 * `Source/ModelData.cpp` — the model itself, as bytes the plugin hands to the reference engine.
 *
 * THE BYTES ARE THE `.nam` FILE, unchanged. Not a re-serialisation, not a converted weight layout: the exact
 * text the training tool wrote, so what the plugin loads is what the file says. That is also what makes the
 * offline proof possible — the reference engine can be handed the same bytes and the two renders compared.
 *
 * Sixteen bytes a line rather than one long line: a 400 KB model is 25,000 lines either way, and a compile
 * error in a file with 25,000-character lines names a character, not a line.
 */
export function modelDataSource(info, text) {
  if (!info) {
    return `// Generated by Morpheus — this project has no .nam model, so there is nothing to embed.
#include "${MODEL_DATA_HEADER.split('/').pop()}"

#if MORPHEUS_HAS_MODEL
#error "ModelData.h says there is a model but ModelData.cpp was generated without one"
#endif
`;
  }
  const bytes = Buffer.from(text, 'utf8');
  const rows = [];
  for (let i = 0; i < bytes.length; i += 16) {
    rows.push(`  ${Array.from(bytes.subarray(i, i + 16), (b) => `0x${b.toString(16).padStart(2, '0')}`).join(', ')},`);
  }
  return `// Generated by Morpheus from ${info.path} — do not edit; it is rewritten on every build.
//
// The .nam exactly as it was written, embedded as bytes. The plugin hands these to NeuralAmpModelerCore
// (nam::get_dsp), which is the reference implementation of the format — see server/src/lib/namPlugin.js for
// why the engine is theirs and not ours.
#include "${MODEL_DATA_HEADER.split('/').pop()}"

#if MORPHEUS_HAS_MODEL
const unsigned char morpheus_model_data[] = {
${rows.join('\n')}
};
const unsigned long morpheus_model_size = sizeof(morpheus_model_data);
#endif
`;
}

/**
 * What a route's build steps have to do about the model: the clone, and the flag that points the configure at
 * it. One function for all three routes, because the pin, the submodule depth and the variable name are
 * exactly the kind of thing that drifts when it is typed three times.
 *
 * The two shells are written out rather than generated from a neutral form. A throw in PowerShell and a
 * non-zero exit in bash are not the same statement, and a translation layer that pretended otherwise would
 * be the place a build quietly stopped failing.
 */
export function namPlan(files, manifest) {
  const model = resolveModel(files, manifest);
  if (!model.info) {
    return { hasModel: false, model: null, clone: { bash: [], powershell: [] }, configure: { bash: '', powershell: '' }, warnings: model.warnings };
  }
  return {
    hasModel: true,
    model: model.info,
    warnings: model.warnings,
    clone: {
      bash: [
        // --depth on the submodule as well: this runs inside every user's build, and the engine's history is
        // not part of what the plugin needs.
        `git clone --quiet ${NAMCORE_REPO} "$RUNNER_TEMP/namcore"`,
        `git -C "$RUNNER_TEMP/namcore" checkout ${NAMCORE_REF}`,
        // ⚠️ EIGEN IS A SUBMODULE. A plain clone leaves Dependencies/eigen empty, and the failure that
        // produces is a missing-header error deep in a library the user has never heard of.
        `git -C "$RUNNER_TEMP/namcore" submodule update --init --depth 1`,
      ],
      powershell: [
        '$ErrorActionPreference = "Stop"',
        `git clone --quiet ${NAMCORE_REPO} "$env:RUNNER_TEMP/namcore"`,
        'if ($LASTEXITCODE -ne 0) { throw "cloning the neural engine failed" }',
        `git -C "$env:RUNNER_TEMP/namcore" checkout ${NAMCORE_REF}`,
        'if ($LASTEXITCODE -ne 0) { throw "checking out the pinned neural engine failed" }',
        `git -C "$env:RUNNER_TEMP/namcore" submodule update --init --depth 1`,
        'if ($LASTEXITCODE -ne 0) { throw "fetching the neural engine\'s dependencies failed" }',
      ],
    },
    configure: {
      bash: '-DMORPHEUS_NAM_DIR="$RUNNER_TEMP/namcore"',
      powershell: '-DMORPHEUS_NAM_DIR="$env:RUNNER_TEMP/namcore"',
    },
  };
}

/**
 * Everything the scaffold needs to know about this project's model, or `null` when it has none.
 *
 * `warnings` are the reason this returns an object rather than a boolean: a project with a `.nam` that cannot
 * be used must still BUILD — Morpheus scaffolds rather than refuses — but it must say so, or the user gets a
 * gain plugin and no explanation for why their amp model is not in it.
 */
export function resolveModel(files, manifest = {}) {
  const path = findModelPath(files, manifest);
  if (!path) return { path: null, info: null, text: null, warnings: [] };

  const text = String((files.find((f) => f.path === path) || {}).content || '');
  const inspected = inspectModel(text);
  if (!inspected.ok) {
    return {
      path,
      info: null,
      text: null,
      warnings: [`${path} is not a usable NAM model — ${inspected.reason}. Building the plugin WITHOUT a model (a stereo gain stage).`],
    };
  }
  const name = manifest.name || 'Morpheus Plugin';
  return {
    path,
    text,
    info: {
      path,
      name,
      architecture: inspected.architecture,
      version: inspected.version,
      sampleRate: inspected.sampleRate,
      weights: inspected.weights,
      bytes: inspected.bytes,
    },
    warnings: [],
  };
}
