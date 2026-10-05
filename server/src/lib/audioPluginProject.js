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
import { PLAIN_CHAIN, chainFor, chainHas, chainParamsStable } from './ampChain.js';
import { ampBoard, boardChain, boardJson, boardParamsStable, readBoard, validateBoard } from './board.js';
import {
  CAB_DATA_HEADER, CAB_DATA_SOURCE, cabDataSource, cabHeader, resolveCab,
} from './cabIr.js';
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
    // Which signal path this plugin is. Empty is the plugin every project got before chains existed, and an
    // unrecognised value is treated the same way rather than guessed at — see lib/ampChain.js.
    chain: parsed.chain == null ? '' : String(parsed.chain),
    // The cabinet impulse response this plugin convolves, when one is named. Empty means "find a .wav in the
    // project", the same rule as the model.
    cab: parsed.cab == null ? '' : String(parsed.cab),
    // ⭐ THE BOARD — the user's own arrangement of blocks, when this project has one. `null` means "this
    // project predates the board", and every consumer falls back to `chain`. See lib/board.js: the fallback
    // is what keeps every project that existed before it generating the same plugin, byte for byte.
    board: (parsed.board && typeof parsed.board === 'object' && !Array.isArray(parsed.board)) ? parsed.board : null,
  };
}

/**
 * The manifest as it is written to disk — the ONE writer, shared by the scaffold and the board route.
 *
 * WHY IT IS SHARED RATHER THAN COPIED. `morpheus.plugin.json` is generated during a compile and edited by the
 * user through the board, which means two writers the moment the board exists. Two writers for one file is
 * exactly how a generated file and an edited file drift into disagreeing about the plugin's own name — and
 * the failure is a plugin that renames itself on the next build.
 *
 * `board` is written LAST and only when there is one, so a project that has no board produces the same
 * manifest text it produced before this key existed. That is what keeps the file diffable across a change
 * that added a feature.
 */
export function manifestJson(manifest, board = null) {
  return `${JSON.stringify({
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
    chain: manifest.chain || '',
    cab: manifest.cab || '',
    ...(board ? { board: boardJson(board) } : {}),
  }, null, 2)}\n`;
}

/**
 * The board a project should OPEN with: its own when it has one, otherwise the arrangement it ALREADY builds.
 *
 * ⚠️ THE FALLBACK IS A READING, NOT A DEFAULT. A project that asked for the amp chain has to open showing the
 * amp chain — an editor that opened with some other arrangement would invite the user to save a board that
 * silently changes the plugin they have been compiling. A project with no chain at all is the single-Gain
 * plugin, which is one block: the output level. It lives here rather than in the route so that the guard can
 * ask this question without a database.
 */
export function boardFor(files) {
  const manifest = readManifest(files);
  const stored = readBoard(manifest);
  if (stored) return stored;
  return String(manifest.chain || '').trim().toLowerCase() === 'amp'
    ? ampBoard()
    : { nextInstanceId: 2, items: [{ instanceId: 1, kind: 'output', enabled: true, values: {} }] };
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

  // The cabinet is DERIVED from the `.wav` in the project, exactly like the model, so it is rewritten for the
  // same reason: replacing `models/cab.wav` and rebuilding has to produce the new speaker.
  const cab = resolveCab(files, manifest);
  for (const w of cab.warnings) warnings.push(w);
  replace(CAB_DATA_HEADER, cabHeader(cab.info));
  replace(CAB_DATA_SOURCE, cabDataSource(cab.info, cab.channels));

  // ── the board, when the project has one ────────────────────────────────────────────────────────────────
  // A board arrives FROM THE USER — it is edited in the app and written back to the manifest — so it is the
  // one input here that can be wrong in a way the file tree cannot show. It is validated rather than
  // repaired: a board that cannot be built falls back to the chain this project would have had, and says so
  // in a warning. Silently fixing a user's arrangement is how a plugin comes back different from the one
  // they drew.
  const board = readBoard(manifest);
  const boardCheck = board ? validateBoard(board, { modelFile: model.info?.path || null, cabFile: cab.info?.path || null }) : null;
  if (boardCheck) {
    for (const w of boardCheck.warnings) warnings.push(w);
    for (const e of boardCheck.errors) warnings.push(`The board was not used: ${e}`);
  }
  const useBoard = Boolean(board && boardCheck.ok);
  const chain = useBoard ? boardChain(board, manifest) : chainFor(manifest);
  const params = useBoard ? boardParamsStable(board, manifest) : chainParamsStable(chain, manifest);

  add(PLUGIN_MANIFEST, manifestJson(manifest, useBoard ? board : null));

  // ⚠️ THIS WARNING USED TO SAY A CABINET DOES NOTHING WITHOUT THE AMP CHAIN, AND THAT WAS NOT TRUE. The
  // cabinet's stage is emitted for every chain and its DSP is behind `#if MORPHEUS_HAS_CAB`, so the plain
  // plugin convolves it too — after its gain stage rather than after the model. Telling a user their cabinet
  // was ignored while it was audibly working is worse than saying nothing, and the board's own warnings now
  // cover the case that matters: a cabinet FILE with no Cabinet BLOCK in the path.
  if (manifest.chain && chainFor(manifest) === PLAIN_CHAIN && !useBoard) {
    warnings.push(`morpheus.plugin.json asks for chain "${manifest.chain}", which this version does not have; building the single-parameter plugin instead. The chain this version knows is "amp".`);
  }
  add(PLUGIN_SOURCE, pluginSource({
    ...manifest,
    chain,
    params,
    // THE FILE AND THE BLOCK ARE DIFFERENT QUESTIONS. A legacy project has no board, so both are true and the
    // generated source is unchanged; a board decides them from its own items.
    modelInPath: useBoard ? chainHas(chain, 'model') : true,
    cabInPath: useBoard ? chainHas(chain, 'cab') : true,
  }));
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
    hasCab: Boolean(cab.info),
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
