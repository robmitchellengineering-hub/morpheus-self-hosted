// The plugin PROJECT both audio-plugin routes generate: its identity, its validation, and its four files.
//
// WHY THIS IS ITS OWN MODULE RATHER THAN CODE IN EITHER TARGET. Morpheus has two audio-plugin routes —
// `audio-plugin-macos` and `audio-plugin-windows` — and they generate the SAME project: one CLAP source
// plus a CMakeLists that configures correctly on whichever platform builds it (the AU parts are gated on
// APPLE inside the generated file, so a Windows configure never touches Apple's AudioUnitSDK). What
// differs between the routes is the runner, the commands and what gets packaged — not the plugin. Two
// copies of a generator is exactly how the two routes would come to build different plugins while both
// looked correct, which is the drift this repository keeps paying for.
//
// IT LIVES OUTSIDE compile-targets/ ON PURPOSE. The `.js` files in that directory ARE the published target
// list — `verify-seo-static.mjs` derives `buildTargets` from a directory listing — so a helper placed in
// there becomes a target with no label, no manual and no build, which is how `audioPluginTemplate.js` first
// shipped twelve targets while the published list said eleven.
import {
  auSubtypeCode, cmakeLists, entrySource, pluginSource, pluginId, fourCharCode,
} from './audioPluginTemplate.js';
import {
  MODEL_DATA_HEADER, MODEL_DATA_SOURCE, modelDataSource, modelHeader, resolveModel,
} from './namPlugin.js';
import { cloneFiles, hasFile, getFileContent, parsePackageJson } from './compile-targets/utils.js';

/**
 * PINNED TO A COMMIT, NOT A BRANCH, and it is not cosmetic.
 *
 * clap-wrapper is fetched from GitHub and compiled as part of every user's build, so `main` would mean the
 * same project builds differently on two different days, and an upstream force-push could change what
 * somebody ships without a line of this repository moving. A pin is also what makes a failure reproducible:
 * "it worked yesterday" is only a useful sentence if yesterday is a fixed commit.
 *
 * IT IS A COMMIT RATHER THAN A TAG, AND THAT IS FORCED ON US. The newest release, v0.9.1, does not provide
 * `make_clapfirst_plugins` at all — the command both routes are built on — so pinning to a tag means the
 * build cannot configure. Verified by trying it: v0.9.1 fails with `Unknown CMake command
 * "make_clapfirst_plugins"`. This commit is the one that was built, wrapped and loaded through the real
 * harness on macOS. Move it only onto a release that has the command, and re-prove BOTH routes if you do.
 */
export const CLAP_WRAPPER_REPO = 'https://github.com/free-audio/clap-wrapper.git';
export const CLAP_WRAPPER_REF = '1cca996e96f29ab2be7ae9f8cfe532bbc92e1dd6';
//
// The neural engine's pin lives in `namPlugin.js` instead — it is the module that knows what a model is, and
// putting it here would make the two modules import each other in a cycle. See NAMCORE_REPO / NAMCORE_REF.

/** The identity file the scaffold writes, and the one place a plugin's name/ID/codes are edited. */
export const PLUGIN_MANIFEST = 'morpheus.plugin.json';

/** Where a hand-written project keeps its source, if the user brought one. */
export const PLUGIN_SOURCE = 'Source/Plugin.cpp';
export const PLUGIN_ENTRY = 'Source/PluginEntry.cpp';

const DEFAULTS = { name: 'Morpheus Plugin', version: '1.0.0', paramName: 'Gain' };

/**
 * The plugin's identity, from the manifest if there is one.
 *
 * The manifest exists because `scaffold(files)` is given the project's FILES and nothing else — not the
 * project name — so the identity has to live in the files or be lost. It also happens to be the right
 * design: the name, bundle id and AU codes are what the user sees in their DAW, so they should be a file
 * they can read and edit rather than something buried in a generator.
 *
 * The AU codes are carried on BOTH platforms even though only Apple has Audio Units. They are identity, not
 * platform code, they cost nothing on Windows, and a project that moves between the two routes keeps the
 * same registration — which matters because two plugins sharing a subtype silently shadow each other.
 */
export function readManifest(files) {
  const raw = getFileContent(files, PLUGIN_MANIFEST);
  let parsed = {};
  if (raw) {
    try { parsed = JSON.parse(raw) || {}; } catch { parsed = {}; }
  }
  const pkg = parsePackageJson(files);
  const name = String(parsed.name || pkg?.name || DEFAULTS.name).trim() || DEFAULTS.name;
  const vendor = String(parsed.vendor || 'Morpheus').trim() || 'Morpheus';
  return {
    name,
    vendor,
    version: String(parsed.version || DEFAULTS.version),
    id: String(parsed.id || pluginId(name)),
    paramName: String(parsed.parameter || DEFAULTS.paramName),
    description: parsed.description ? String(parsed.description) : '',
    // `aufx` = audio effect, `augn` = instrument. The generator sets this from the request; a plugin with
    // the wrong one is filed under the wrong heading in Logic and cannot be found.
    auType: String(parsed.auType || 'aufx'),
    auSubtype: String(parsed.auSubtype || auSubtypeCode(name)),
    auManufacturer: String(parsed.auManufacturer || fourCharCode(vendor, 'Morp')),
    // The `.nam` this plugin runs, when one is named. Empty means "find one in the project", which is what
    // most projects want; naming it is how a project carrying two models picks between them.
    model: parsed.model == null ? '' : String(parsed.model),
  };
}

/** What is wrong with this workspace, as warnings the user can act on. Never a refusal: Morpheus scaffolds. */
export function validatePlugin(files) {
  const warnings = [];
  const manifest = readManifest(files);
  const hasSource = hasFile(files, PLUGIN_SOURCE);
  const hasCmake = hasFile(files, 'CMakeLists.txt');

  // A project that brought its own CLAP source is compiled as-is. That is a supported path — it is how
  // someone continues work on a plugin Morpheus generated earlier — so it is a note, not an error.
  if (hasSource && hasCmake) {
    warnings.push('Using the CLAP project already in this workspace; Morpheus will not overwrite Source/Plugin.cpp.');
  }
  if (hasSource && !hasCmake) {
    warnings.push('Source/Plugin.cpp is present but there is no CMakeLists.txt — one will be generated around it.');
  }
  // The AU codes are four characters and are how Logic names and finds the plugin. Two plugins sharing
  // a subtype shadow each other, which is invisible until one goes missing.
  if (manifest.auSubtype.length !== 4 || manifest.auManufacturer.length !== 4) {
    warnings.push('AU registration codes are not four characters; Logic may not list this plugin correctly.');
  }
  if (!/^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(manifest.id)) {
    warnings.push(`Plugin id "${manifest.id}" does not look like a reverse-domain identifier.`);
  }
  return { valid: true, warnings };
}

/**
 * Generate the plugin project. Anything already present is left alone, so this is safe to run over a
 * project someone has edited — regenerating a user's DSP would be the worst possible behaviour here.
 */
export function scaffoldPlugin(files) {
  const warnings = [];
  const generated = [];
  const out = cloneFiles(files);
  const manifest = readManifest(files);

  const add = (path, content) => {
    if (hasFile(out, path)) return;
    out.push({ path, content });
    generated.push(path);
  };

  // ⚠️ THE ONE GENERATED FILE THAT IS ALWAYS REWRITTEN, and it has to be. Everything else in this list is a
  // starting point a user is expected to edit, so it is written once and left alone. The model is not a
  // starting point — it is DERIVED from the `.nam` in the project, and leaving it alone would mean replacing
  // `models/amp.nam` and rebuilding produced the old amp. Its own header says it is generated, for the same
  // reason: a user who edits it should know before they lose it, not after.
  const model = resolveModel(files, manifest);
  for (const w of model.warnings) warnings.push(w);
  const replace = (path, content) => {
    const at = out.findIndex((f) => f.path === path);
    if (at === -1) out.push({ path, content });
    else out[at] = { path, content };
    if (!generated.includes(path)) generated.push(path);
  };
  replace(MODEL_DATA_HEADER, modelHeader(model.info));
  replace(MODEL_DATA_SOURCE, modelDataSource(model.info, model.text));

  add(PLUGIN_MANIFEST, `${JSON.stringify({
    name: manifest.name,
    vendor: manifest.vendor,
    version: manifest.version,
    id: manifest.id,
    parameter: manifest.paramName,
    description: manifest.description,
    auType: manifest.auType,
    auSubtype: manifest.auSubtype,
    auManufacturer: manifest.auManufacturer,
    // Carried through so the choice survives a re-scaffold. Empty rather than absent keeps the file's shape
    // stable, which is what makes the generated manifest diffable between two builds.
    model: manifest.model || '',
  }, null, 2)}\n`);

  add(PLUGIN_SOURCE, pluginSource(manifest));
  add(PLUGIN_ENTRY, entrySource());
  add('CMakeLists.txt', cmakeLists({
    name: manifest.name,
    id: manifest.id,
    version: manifest.version,
    auType: manifest.auType,
    auSubtype: manifest.auSubtype,
    auManufacturer: manifest.auManufacturer,
    auManufacturerName: manifest.vendor,
    // The CMakeLists is the one generated file that DOES differ with and without a model: with one it compiles
    // the reference engine into the plugin, without one there is nothing to compile. The plugin source itself
    // does not differ — see namPlugin.js's note on why that matters for the test bench.
    hasModel: Boolean(model.info),
    modelPath: model.info ? model.info.path : null,
    modelArchitecture: model.info ? model.info.architecture : null,
  }));

  // The entry file exports three symbols that our Plugin.cpp defines. Over somebody else's source that
  // is a link error with no explanation, so say it here rather than in a build log they will not read.
  if (hasFile(files, PLUGIN_SOURCE) && generated.includes(PLUGIN_ENTRY)) {
    warnings.push(
      `${PLUGIN_ENTRY} was generated to match Morpheus's own source, so your ${PLUGIN_SOURCE} must export `
      + 'morpheus_plugin_init, morpheus_plugin_deinit and morpheus_plugin_get_factory — or supply your own '
      + `${PLUGIN_ENTRY}.`,
    );
  }
  return { files: out, generated, warnings };
}
