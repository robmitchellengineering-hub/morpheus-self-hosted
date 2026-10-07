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
import { rigList } from './rig.js';

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
export function findModelPaths(files, manifest = {}) {
  return rigList({ files, manifest, listKey: 'models', oneKey: 'model', has: hasModel, match: (p) => /\.nam$/i.test(p), rank });
}

/**
 * The FIRST capture — what this function has always returned, and the reason it is defined in terms of the
 * list above rather than the other way round. One model, many models and no model are one question.
 */
export function findModelPath(files, manifest = {}) {
  const all = findModelPaths(files, manifest);
  return all.length ? all[0].path : null;
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
  // ── A CONTAINER IS NOT A MODEL WITH ITS WEIGHTS IN THE USUAL PLACE ────────────────────────────────────────
  // ⚠️ THIS CHECK REJECTED THE FORMAT NAM IS MOVING TO, and it did it as "has no weights array", which reads
  // like a corrupt file rather than like a format we do not handle. NAM A2's file is a `SlimmableContainer`:
  // SEVERAL submodels of the same amp at different sizes, chosen at runtime via `SetSlimmableSize`, with the
  // weights living in `config.submodels[].model` and the top-level `weights` deliberately EMPTY. Measured
  // 2026-10-05 against NeuralAmpModelerCore 0b3d3c9: `A2.nam` is exactly that, and the engine loads it
  // happily — `nam::get_dsp` returns a ContainerModel with two WaveNet submodels (1,871 and 12,146 weights).
  // So the engine was never the problem; this gate was, and a flat-weight-only gate is a gate on one format.
  const isContainer = String(raw.architecture) === 'SlimmableContainer';
  if (isContainer) {
    const subs = raw.config && Array.isArray(raw.config.submodels) ? raw.config.submodels : null;
    if (!subs || subs.length === 0) return { ok: false, reason: 'is a SlimmableContainer with no submodels' };
    const submodels = [];
    for (let i = 0; i < subs.length; i++) {
      const m = subs[i] && subs[i].model;
      if (!m || !Array.isArray(m.weights) || m.weights.length === 0) {
        return { ok: false, reason: `submodel ${i} has no weights array` };
      }
      // The same raw-value check as below, per submodel: a container is not an excuse for letting a null
      // through, and a container is where a truncated file is easiest to miss because the total still looks
      // plausible.
      const bad = m.weights.findIndex((w) => typeof w !== 'number' || !Number.isFinite(w));
      if (bad !== -1) return { ok: false, reason: `submodel ${i} weight ${bad} is not a finite number` };
      submodels.push({
        maxValue: typeof subs[i].max_value === 'number' ? subs[i].max_value : null,
        architecture: m.architecture == null ? null : String(m.architecture),
        weights: m.weights.length,
      });
    }
    return {
      ok: true,
      architecture: 'SlimmableContainer',
      version: raw.version == null ? null : String(raw.version),
      sampleRate: typeof raw.sample_rate === 'number' ? raw.sample_rate
        : (typeof subs[subs.length - 1].model.sample_rate === 'number' ? subs[subs.length - 1].model.sample_rate : null),
      weights: submodels.reduce((n, m) => n + m.weights, 0),
      // `slimmable` is what the scaffold and the plugin branch on: this model can be resized at runtime, so
      // the device tier can offer one file with a quality dial instead of a folder of separate models.
      slimmable: true,
      submodels,
      missing: MODEL_FIELDS.filter((k) => raw[k] === undefined),
      bytes: Buffer.byteLength(text, 'utf8'),
    };
  }
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
    slimmable: false,
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
 *
 * ⭐ AND IT DECLARES THE RIG, WHEN THERE IS ONE. The table itself is DEFINED in `ModelData.cpp` (see
 * `modelRigTableCpp`), which is a different translation unit from the plugin, so `Plugin.cpp` can only index
 * it through a declaration here. `models` is the resolved rig; the count is taken through the same filter
 * the `.cpp` uses, so the two files cannot come to disagree about how many captures there are.
 *
 * ⚠️ A RIG OF FEWER THAN TWO DECLARES NOTHING, AND THE DIRECTION OF THAT MATTERS. One capture has nothing to
 * choose between, so `modelDataSourceAll` emits no table — a declaration here would promise a symbol the
 * `.cpp` never defines and the project would fail to link. It is also what keeps this header's bytes
 * unchanged for every project that has no rig, which is the whole point of the N >= 2 rule.
 */
export function modelHeader(info, models = null) {
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
  const rig = usableModels(models);
  const rigDecl = rig.length >= 2 ? `
// ⭐ THE RIG, declared here because its definition is in ModelData.cpp. \`static\` is what it cannot be
// there: the plugin is a different translation unit, so the table needs external linkage to be readable.
#if MORPHEUS_HAS_MODEL
#define MORPHEUS_RIG_MODELS ${rig.length}
struct morpheus_rig_model { const char *name; const unsigned char *data; unsigned int size; };
extern const morpheus_rig_model kMorpheusRigModels[MORPHEUS_RIG_MODELS];
#endif
` : '';
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
${rigDecl}`;
}

/**
 * One `.nam`'s bytes as a C++ array, sixteen a line.
 *
 * Shared by the first capture and by every extra one, because a rig's arrays must be the SAME bytes in the
 * same layout: an extra array that differed in line length or indentation would still compile, and would make
 * two arrays of the same file diff against each other for a reason nobody could name.
 */
function modelBytesCpp(name, text) {
  const bytes = Buffer.from(String(text ?? ''), 'utf8');
  const rows = [];
  for (let i = 0; i < bytes.length; i += 16) {
    rows.push(`  ${Array.from(bytes.subarray(i, i + 16), (b) => `0x${b.toString(16).padStart(2, '0')}`).join(', ')},`);
  }
  return `const unsigned char ${name}[] = {\n${rows.join('\n')}\n};`;
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
  return `// Generated by Morpheus from ${info.path} — do not edit; it is rewritten on every build.
//
// The .nam exactly as it was written, embedded as bytes. The plugin hands these to NeuralAmpModelerCore
// (nam::get_dsp), which is the reference implementation of the format — see server/src/lib/namPlugin.js for
// why the engine is theirs and not ours.
#include "${MODEL_DATA_HEADER.split('/').pop()}"

#if MORPHEUS_HAS_MODEL
${modelBytesCpp('morpheus_model_data', text)}
const unsigned long morpheus_model_size = sizeof(morpheus_model_data);
#endif
`;
}

/**
 * The members of a rig that can actually be emitted — the ONE filter the header's count and the `.cpp`'s
 * table have to agree on.
 *
 * ⚠️ TWO FILTERS THAT MEAN THE SAME THING ARE TWO FILTERS THAT DRIFT, and the failure is a header promising
 * three entries beside a table that holds two. A member with no `info` is kept by `resolveModels` so its
 * warning reaches the scaffold (see `modelDataSourceAll`); it has no bytes, so it is not a row.
 */
const usableModels = (models) => (Array.isArray(models) ? models : []).filter((m) => m && m.info);

/**
 * `Source/ModelData.cpp` for a whole RIG — one capture, several, or none.
 *
 * ⭐ THE FIRST CAPTURE IS THE SINGULAR FUNCTION'S OUTPUT, AS A PREFIX, AND THAT IS THE DESIGN RATHER THAN A
 * SHORTCUT. Every proof of this target that predates the rig — the three runner builds, the test bench, the
 * measured +5.92 dB — measured a plugin generated from exactly this text, and a rig-of-one re-emitted through
 * a new code path would only be trustworthy if the two paths happened to agree. Appending to the singular
 * output makes that agreement structural: nothing above the extras can move without moving them.
 *
 * ⭐ AND FOR A RIG OF ONE THIS RETURNS THE SINGULAR OUTPUT ENTIRELY — NO TABLE. There is nothing to select
 * between, so a one-row table would be dead weight; more than that, emitting it would move a one-capture
 * project's bytes away from what every existing proof measured, which is the one thing this change must not
 * do. `morpheus_model_data` is the runtime's answer for N == 1; the table is for N >= 2.
 *
 * ⚠️ A MEMBER WITH NO `info` IS DROPPED HERE, AND THIS IS THE ONLY PLACE IT CAN BE. `resolveModels` keeps it
 * as a member precisely so its warning reaches the scaffold; there are no bytes to embed, and a zero-length
 * array in its place would hand `nam::get_dsp` an empty document for a `.nam` that is sitting right there in
 * the project — a plugin that loads and plays nothing, which is exactly what the warning exists to prevent.
 * So a rig of three with a corrupt capture in the middle builds from the other two and says what became of
 * the third.
 *
 * The extras are suffixed (`morpheus_model_data_2`, …) rather than the first being renamed, so a selector can
 * be added later without an existing symbol moving: `morpheus_model_data` is the name every render check and
 * the plugin itself already use.
 */
export function modelDataSourceAll(models) {
  const rig = usableModels(models);
  if (!rig.length) return modelDataSource(null, null);
  // ⭐ N == 1 IS THE SINGULAR EMISSION, VERBATIM. A table with one entry is a table nobody can select from, and
  // emitting it would move a one-capture project's source. Only a rig actually offering a choice gets a table.
  if (rig.length === 1) return modelDataSource(rig[0].info, rig[0].text);

  const extras = rig.slice(1).map((m, i) => modelExtraCpp(m, i + 2)).join('\n');
  return `${modelDataSource(rig[0].info, rig[0].text)}
#if MORPHEUS_HAS_MODEL
${extras ? `${extras}\n` : ''}${modelRigTableCpp(rig)}#endif
`;
}

/** The array a rig member's bytes live in. The first is unsuffixed because it is the one that already exists. */
const modelArrayName = (index) => (index === 0 ? 'morpheus_model_data' : `morpheus_model_data_${index + 1}`);

/**
 * One extra capture: its own array, and the byte and weight counts that array is.
 *
 * Those two counts are the same facts `modelHeader` carries for the first capture, and they are emitted here
 * for the extras because the header still describes the first capture alone — see `modelHeader`. A caller
 * that wants them for the whole rig reads the table below, which is the single description of the rig.
 */
function modelExtraCpp(model, index) {
  const array = modelArrayName(index - 1);
  return `// ── capture ${index}: ${model.name} (from ${model.path})
// The same bytes and the same engine as the first array; the name and the two counts are what is new.
#define MORPHEUS_MODEL_BYTES_${index} ${model.info.bytes}
#define MORPHEUS_MODEL_WEIGHTS_${index} ${model.info.weights}
${modelBytesCpp(array, model.text)}
const unsigned long morpheus_model_size_${index} = sizeof(${array});
`;
}

/**
 * THE RIG, in selector order — the one thing a runtime needs and cannot derive from the arrays themselves.
 *
 * ⭐ IT IS A TABLE OF POINTERS RATHER THAN AN API. Every entry is a compile-time address and the table
 * allocates nothing, which is the only shape that works both in `init()`, where allocating is allowed, and on
 * the audio thread, where it is not. Each entry is the display name a player reads and the array it selects.
 *
 * ⭐ THE TYPE AND THE COUNT LIVE IN THE HEADER, and this definition repeats neither. `morpheus_rig_model` is
 * declared in `ModelData.h` because `Plugin.cpp` indexes the table, and `MORPHEUS_RIG_MODELS` is defined
 * there because the count belongs beside the declaration — so the two files cannot come to disagree about
 * how many rows there are.
 *
 * ⚠️ IT IS `const`, NOT `static const`, AND THE DIFFERENCE IS A LINK ERROR RATHER THAN A STYLE CHOICE. A
 * `static` table has internal linkage, so the `extern` declaration in the header would resolve to a symbol
 * this translation unit never exports and the plugin would fail to link. A syntax-only compile cannot see it;
 * found by compiling the emitted rig rather than by reading it.
 *
 * ⚠️ IT IS EMITTED ONLY FOR A RIG OF TWO OR MORE, and inside `#if MORPHEUS_HAS_MODEL`, the same guard the
 * extras are under. A project with no capture, and a project with exactly one, therefore generate exactly the
 * translation unit they generated before the rig existed — see `modelDataSourceAll`. That byte-identity is the
 * whole point; a one-row table would buy nothing and cost it.
 */
function modelRigTableCpp(rig) {
  const rows = rig.map((m, i) => {
    const array = modelArrayName(i);
    return `   { ${cString(m.name)}, ${array}, (unsigned int)sizeof(${array}) },`;
  }).join('\n');
  return `const morpheus_rig_model kMorpheusRigModels[] = {
${rows}
};
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
  // ⚠️ THE FIRST USABLE CAPTURE, WHICH IS NOT NECESSARILY THE FIRST FOUND, AND ASKING THE OTHER QUESTION IS A
  // BUILD THAT CANNOT CONFIGURE. `scaffoldPlugin` writes its CMakeLists from that member (see
  // audioPluginProject.js), and this plan is what decides whether the runner clones the engine and passes
  // `-DMORPHEUS_NAM_DIR` — so `resolveModel` here would omit the clone for a rig whose first capture is
  // corrupt while the CMakeLists still compiles the engine against a directory that was never fetched. One
  // question, asked in both places through the same filter.
  const models = resolveModels(files, manifest);
  const warnings = models.flatMap((m) => m.warnings || []);
  const model = models.find((m) => m && m.info) || null;
  if (!model) {
    return { hasModel: false, model: null, clone: { bash: [], powershell: [] }, configure: { bash: '', powershell: '' }, warnings };
  }
  return {
    hasModel: true,
    model: model.info,
    warnings,
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
 * EVERY capture this project carries, in the order the rig should offer them.
 *
 * ⚠️ AN UNUSABLE MEMBER IS KEPT AS A MEMBER, NOT DROPPED HERE. `{ path, info: null, warnings: [...] }` is what
 * the singular version returned for a `.nam` that is present but cannot be used, and that warning is the only
 * thing that tells the user why their amp is missing from a plugin that still built. Dropping it here would be
 * silent, which is the one thing this module is not allowed to be about a file the user put in the project.
 *
 * ⭐ AND `name` IS THE CAPTURE'S OWN NAME, FROM THE FINDER — while `info.name` is the PLUGIN's name and stays
 * that way. `modelHeader` has always written `MORPHEUS_MODEL_NAME` from `info.name`, so moving the capture's
 * name onto it would rename the plugin in every project that has a model. The two names are different facts
 * and they are deliberately two fields on one object.
 */
export function resolveModels(files, manifest = {}) {
  return findModelPaths(files, manifest).map(({ path, name }) => resolveModelMember(files, manifest, path, name));
}

/**
 * The FIRST capture — what this function has always returned, and the reason it is defined as the plural
 * list's first element rather than as a separate search. One model, many models and no model are one question.
 */
export function resolveModel(files, manifest = {}) {
  const all = resolveModels(files, manifest);
  return all.length ? all[0] : { path: null, info: null, text: null, warnings: [] };
}

/** One member of the rig, in the shape the singular resolver has always returned. */
function resolveModelMember(files, manifest, path, name) {
  const text = String((files.find((f) => f.path === path) || {}).content || '');
  const inspected = inspectModel(text);
  if (!inspected.ok) {
    return {
      path,
      name,
      info: null,
      text: null,
      warnings: [`${path} is not a usable NAM model — ${inspected.reason}. It is left out of the rig; a rig with no usable capture is a stereo gain stage.`],
    };
  }
  return {
    path,
    name,
    text,
    info: {
      path,
      // ⚠️ THE PLUGIN'S NAME, NOT THE CAPTURE'S — see resolveModels. Renaming this field renames the plugin.
      name: manifest.name || 'Morpheus Plugin',
      architecture: inspected.architecture,
      version: inspected.version,
      sampleRate: inspected.sampleRate,
      weights: inspected.weights,
      bytes: inspected.bytes,
      // ⚠️ CARRIED THROUGH, NOT DROPPED. This projection is what the scaffold and the compile panel actually
      // see, so a field that stops here does not exist as far as the product is concerned: a container's
      // `slimmable` and its submodel sizes are the whole reason NAM A2 is useful on a device, and leaving
      // them in `inspectModel` alone made the format pass validation while nothing could act on it.
      slimmable: inspected.slimmable === true,
      ...(inspected.submodels ? { submodels: inspected.submodels } : {}),
    },
    warnings: [],
  };
}
