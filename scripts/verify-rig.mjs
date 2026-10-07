// The RIG as a PROJECT DOCUMENT: the captures and mics a project carries, and the app that builds one.
//
// WHY THIS GUARD EXISTS, AND WHY IT IS NOT PART OF verify-audio-plugin.
// `verify-audio-plugin.mjs` proves the plugin the generator WRITES: N captures embedded, a table declared,
// two discrete selectors, a pointer swap on the audio thread. This is the other half of Stage 5 — the APP
// side of the same document — and its failure modes are invisible to every check over there:
//
//   * an app that offers a capture the generator DROPPED, so the user picks a member the plugin will not
//     play (the count and the table come from one filter in the generator; the app must ask the same one);
//   * a rig editor whose save is accepted and silently shortened, because the finder drops a path it cannot
//     find and drops a duplicate — "saved" plus "not used", which is the worst of both;
//   * a manifest writer that drops a key the user added, because it regenerated the file from the normalised
//     manifest instead of editing the one on disk;
//   * the board editor and the plugin drawing DIFFERENT block sequences — the exact class of bug that
//     shipped once already (#581: the panel drew a block order the audio did not run);
//   * and, the one this whole change is about, the app drawing the Amp model and Cabinet blocks with no
//     controls while the plugin draws a Capture and a Speaker choice under each.
//
// Dependency-free: it imports the pure lib modules and nothing else, so it runs in CI's no-install guards job.
//
// Run:  node scripts/verify-rig.mjs
import audioPlugin, { PLUGIN_MANIFEST, readManifest } from '../server/src/lib/compile-targets/audio-plugin-macos.js';
import { manifestJson, manifestWith } from '../server/src/lib/audioPluginProject.js';
import { ampBoard, boardChain, boardView, validateBoard } from '../server/src/lib/board.js';
import { blocksCpp, rigSelectors, stageLabel } from '../server/src/lib/ampChain.js';
import { rigName } from '../server/src/lib/rig.js';
import { isCapturePath, rigPatch, rigView } from '../server/src/lib/rigProject.js';
import { encodeWav } from '../server/src/lib/audio/wav.js';

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}
const generated = (result, path) => result.files.find((f) => f.path === path)?.content || '';

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────────────
// A real capture is JSON with an architecture and finite weights; `inspectModel` is the generator's own gate,
// so a fixture it rejects is not a usable member anywhere in this file.
const namFor = (arch = 'Linear') => JSON.stringify({ version: '0.5.4', architecture: arch, config: {}, weights: [1.0], sample_rate: 48000 });
const IR = (tau, seed) => {
  const data = new Float32Array(512);
  let x = seed;
  for (let i = 0; i < 512; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; data[i] = ((x / 0x7fffffff) * 2 - 1) * Math.exp(-i / tau) * 0.4; }
  return encodeWav({ sampleRate: 48000, data, format: 'float32' }).toString('base64');
};
const manifestOf = (obj) => ({ path: PLUGIN_MANIFEST, content: JSON.stringify(obj) });

const RIG_MANIFEST = {
  name: 'Rig', chain: 'amp',
  // ⚠️ THE CORRUPT MEMBER IS THE POINT OF THE FIXTURE. `resolveModels` KEEPS it so its warning can surface
  // and `modelDataSourceAll` DROPS it from the emitted table — so an app that simply listed the manifest
  // would offer three captures where the plugin has two, and the third would play nothing.
  models: [
    { path: 'models/a.nam', name: 'Clean' },
    { path: 'models/broken.nam', name: 'Broken' },
    { path: 'models/c.nam', name: 'Lead' },
  ],
  cabs: [
    { path: 'models/mic-a.wav', name: '545' },
    { path: 'models/mic-b.wav', name: 'U87' },
  ],
};
const RIG_FILES = [
  manifestOf(RIG_MANIFEST),
  { path: 'models/a.nam', content: namFor() },
  { path: 'models/broken.nam', content: 'this is not a model' },
  { path: 'models/c.nam', content: namFor('WaveNet') },
  // ⚠️ A CAPTURE THE RIG DOES NOT NAME. It is in the project and the manifest's list is explicit, so the
  // plugin will not play it — and the whole point of the "also in this project" group is that this is
  // otherwise invisible: the file is there, the user put it there, and nothing says it is not in the plugin.
  { path: 'models/d.nam', content: namFor('LSTM') },
  { path: 'models/mic-a.wav', content: IR(40, 11), encoding: 'base64' },
  { path: 'models/mic-b.wav', content: IR(40, 12), encoding: 'base64' },
];

console.log('\n1. the view reads BOTH halves the way the scaffold does');
const view = rigView(RIG_FILES, readManifest(RIG_FILES));
check('an explicit rig is the manifest\'s LIST, in its order',
  view.models.members.map((m) => m.name), ['Clean', 'Broken', 'Lead']);
check('…with the unusable member KEPT and marked, so its warning reaches the user',
  view.models.members.map((m) => m.usable), [true, false, true]);
check('…and the members the PLUGIN will actually offer are the usable ones, in order',
  view.selectors.models.map((m) => m.name), ['Clean', 'Lead']);
check('…the mics too, from the same finders', view.selectors.cabs.map((c) => c.name), ['545', 'U87']);
// An automatic rig is every file of that kind, which is the behaviour a project had before this editor
// existed — so a project with no rig key must keep offering everything it holds.
const auto = rigView(RIG_FILES.slice(1), readManifest(RIG_FILES.slice(1)));
check('a project with no rig is AUTOMATIC: every capture it holds is offered',
  [auto.models.auto, auto.models.members.length, auto.models.others.length], [true, 4, 0]);
check('…and naming one is what freezes the list, which is why the others are listed separately',
  [view.models.auto, view.models.others.map((o) => o.name)], [false, ['D']]);
check('⭐ a capture the rig does not name is SAID, not silently dropped',
  view.warnings.some((w) => /not in the rig/.test(w) && /D/.test(w)), true);
// The one-member note is the app's answer to "where did the Capture control go" — see rigSelectors.
const oneModelFiles = [manifestOf({ name: 'R' }), { path: 'models/only.nam', content: namFor() }];
const oneModel = rigView(oneModelFiles, readManifest(oneModelFiles));
check('one capture is not a control, and the view says so rather than leaving a blank',
  oneModel.warnings.some((w) => /no Capture control/.test(w)), true);

console.log('\n2. a save that cannot be built is REFUSED, not silently shortened');
const files = RIG_FILES.slice(1);
check('a good list is normalised through the one entry validator',
  rigPatch({ models: [{ path: 'models/a.nam' }, 'models/c.nam'] }, { files }).patch,
  { models: [{ path: 'models/a.nam', name: 'A' }, { path: 'models/c.nam', name: 'C' }] });
check('⚠️ a path the project does not hold is an ERROR — the finder would drop it',
  rigPatch({ models: ['models/nope.nam'] }, { files }).errors.length, 1);
check('⚠️ a duplicate is an ERROR — two selector positions playing one capture',
  rigPatch({ models: ['models/a.nam', 'models/a.nam'] }, { files }).errors.length, 1);
check('a wrong extension is an ERROR', rigPatch({ models: ['models/mic-a.wav'] }, { files }).errors.length, 1);
check('⚠️ an EMPTY list is refused by name, because an empty list is what puts every capture back',
  /every capture back|every capture/i.test(rigPatch({ models: [] }, { files }).errors[0] || ''), true);
check('…and `null` is the DIFFERENT thing it looks like: clear the key, so the project decides again',
  rigPatch({ models: null }, { files }).patch, { models: null });
check('a half the caller did not mention is left alone',
  Object.prototype.hasOwnProperty.call(rigPatch({ models: ['models/a.nam'] }, { files }).patch, 'cabs'), false);

console.log('\n3. the ONE manifest writer: edit the file, never regenerate it');
const userManifest = `${JSON.stringify({ name: 'Mine', chain: 'amp', models: ['models/a.nam'], myOwnKey: { keep: true } }, null, 2)}\n`;
const written = manifestWith(userManifest, { name: 'Mine' }, { models: [{ path: 'models/c.nam', name: 'Lead' }] });
check('⭐ a key the user added to their own manifest SURVIVES an edit',
  JSON.parse(written).myOwnKey, { keep: true });
check('…and the key being edited is the one that changed',
  JSON.parse(written).models, [{ path: 'models/c.nam', name: 'Lead' }]);
check('…`null` REMOVES the key rather than writing an empty list the finders would ignore',
  Object.prototype.hasOwnProperty.call(JSON.parse(manifestWith(userManifest, { name: 'Mine' }, { models: null })), 'models'), false);
const noRig = manifestWith(null, { name: 'Morpheus Plugin', vendor: 'Morpheus', version: '1.0.0', id: 'nz.morpheus.morpheus.plugin', paramName: 'Gain', description: '', auType: 'aufx', auSubtype: 'MorM', auManufacturer: 'Morp', model: '', chain: '', cab: '' }, {});
check('⭐ a project with no rig writes NEITHER key — the byte-identity rule',
  [noRig.includes('"models"'), noRig.includes('"cabs"')], [false, false]);
check('…and that is byte-identical to what the scaffolder\'s writer produces for the same project',
  noRig, manifestJson({ name: 'Morpheus Plugin', vendor: 'Morpheus', version: '1.0.0', id: 'nz.morpheus.morpheus.plugin', paramName: 'Gain', description: '', auType: 'aufx', auSubtype: 'MorM', auManufacturer: 'Morp', model: '', chain: '', cab: '' }));

console.log('\n4. ⭐ THE APP AND THE PLUGIN NAME THE SAME MEMBERS — the count is one filter');
const scaffolded = audioPlugin.scaffold(RIG_FILES);
const modelData = generated(scaffolded, 'Source/ModelData.cpp');
const cabData = generated(scaffolded, 'Source/CabIr.cpp');
const pluginSrc = generated(scaffolded, 'Source/Plugin.cpp');
const tableNames = (text, symbol) => [...text.matchAll(new RegExp(`\\{ "([^"]+)", ${symbol}`, 'g'))].map((m) => m[1]);
check('the emitted plugin carries the two usable captures and both mics',
  [tableNames(modelData, 'morpheus_model_data'), tableNames(cabData, 'morpheus_cab_l')],
  [['Clean', 'Lead'], ['545', 'U87']]);
check('⭐ …and the app offers EXACTLY those names, in that order — the corrupt member cannot be picked',
  [view.selectors.models.map((m) => m.name), view.selectors.cabs.map((c) => c.name)],
  [tableNames(modelData, 'morpheus_model_data'), tableNames(cabData, 'morpheus_cab_l')]);
check('…and the selectors the generator appends are sized to that same count',
  rigSelectors({ models: view.selectors.models.length, cabs: view.selectors.cabs.length }).map((s) => [s.key, s.max, s.module]),
  [['model_select', 1, 'Amp model'], ['cab_select', 1, 'Cabinet']]);
check('…which is the parameters the generated plugin actually carries',
  [/\{ 12, "Capture", 0\.0, 1\.0, 0\.0, "", 1, "Amp model" \}/.test(pluginSrc),
    /\{ 13, "Speaker", 0\.0, 1\.0, 0\.0, "", 1, "Cabinet" \}/.test(pluginSrc)],
  [true, true]);

console.log('\n5. ⭐ THE BOARD EDITOR AND THE PLUGIN DRAW ONE SIGNAL PATH');
// The board is the document; the plugin's block list is emitted from the SAME stage list the DSP walks, so
// the two ORDERINGS have to agree item for item. `kindOfStage` is `board.js`\'s own inverse mapping, written
// out here independently — a guard that called the same helper would be the function checking itself.
const board = ampBoard();
const appKinds = boardView(board, { rig: view.selectors }).blocks.map((b) => b.kind);
const stageKind = (k) => (k === 'gain' ? 'input' : (k === 'level' ? 'output' : k));
check('the app draws the same blocks, in the same order, as the stage list the DSP walks',
  appKinds, boardChain(board).stages.map((s) => stageKind(s.kind)));
check('…and the plugin\'s own block table is that same list, in that order',
  blocksCpp(boardChain(board)).includes(boardChain(board).stages.map((s) => `   "${stageLabel(s)}",`).join('\n')), true);
// And the divergence this change fixes: those two blocks had NO controls in the app while the plugin drew a
// choice under each. A view that drew them bare is what this assertion is for.
const modelBlock = boardView(board, { rig: view.selectors }).blocks.find((b) => b.kind === 'model');
const cabBlock = boardView(board, { rig: view.selectors }).blocks.find((b) => b.kind === 'cab');
check('⭐ the Amp model block names the rig\'s captures, so the app draws the control the plugin has',
  modelBlock.controls.filter((c) => c.select).map((c) => [c.key, c.options]), [['model_select', ['Clean', 'Lead']]]);
check('⭐ …and the Cabinet block names its mics',
  cabBlock.controls.filter((c) => c.select).map((c) => [c.key, c.options]), [['cab_select', ['545', 'U87']]]);
check('one member is not a choice, so a one-capture project draws no extra row at all',
  boardView(board, { rig: { models: [{ path: 'models/a.nam', name: 'Clean' }], cabs: [] } })
    .blocks.flatMap((b) => b.controls.filter((c) => c.select)).length, 0);
check('…and a board with no rig at all is unchanged',
  boardView(board, {}).blocks.flatMap((b) => b.controls.filter((c) => c.select)).length, 0);
check('…and the board still validates the way it always did',
  validateBoard(board, { modelFile: 'models/a.nam', cabFile: 'models/mic-a.wav' }).ok, true);
check('…and a capture path is recognised by the route that owns it, so a delete cannot be pointed at a source file',
  [isCapturePath('models/a.nam'), isCapturePath('Source/Plugin.cpp')], [true, false]);
check('…and a filename becomes a name a player can read',
  [rigName('models/marshall_crunch-2.nam'), rigName('models/57.wav')], ['Marshall Crunch 2', '57']);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) { console.log('the rig is described differently on one side of the app than the other'); process.exit(1); }
console.log('the app and the plugin describe one rig, and a save cannot shorten it silently');
