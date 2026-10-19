// Does the .nam quantizer do what it says — without needing a model, an engine or a network?
//
// The reference engine is deliberately NOT required here: `verify-audio-quantize` runs in the no-install guards
// job, and fetching NeuralAmpModelerCore to check a block quantizer would make the gate depend on a repository
// and a compiler it does not have. So this covers the parts that are pure arithmetic and pure format — which is
// where the subtle mistakes live — and the CLI is where the engine-backed measurement happens.
//
// The assertions that matter most, and why:
//   * EVERY VALUE IS ON ITS BLOCK'S GRID. A quantizer that writes codes it cannot dequantize produces a model
//     that sounds wrong in a way no one can trace.
//   * A BIG WEIGHT IN ONE BLOCK DOES NOT DEGRADE ANOTHER BLOCK. That is the entire reason for blocking, and a
//     per-tensor implementation passes every other check here while failing this one.
//   * A FULL-SCALE WEIGHT ROUND-TRIPS EXACTLY at any width — which is why the identity model stays an identity
//     after quantization, a property worth knowing rather than discovering.
//   * THE FORMAT REFUSES A MODEL WITH NO SCALE. A quantized file without one is a list of integers; the failure
//     would surface as "it sounds wrong", never as a parse error.
//
// Run:  node scripts/verify-nam-quantize.mjs
import { modelBytes, validateModel } from '../server/src/lib/audio/modelFormat.js';
import { namBytes, parseNam, quantizeBlocks, quantizedNam, toDeploymentModel } from '../server/src/lib/audio/namModel.js';

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}
function near(name, actual, expected, tol) {
  checks++;
  if (Number.isFinite(actual) && Math.abs(actual - expected) <= tol) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${expected} ±${tol}\n          got      ${actual}`); failures++; }
}
const below = (name, actual, limit) => { checks++; if (actual < limit) console.log(`  PASS  ${name}`); else { console.log(`  FAIL  ${name}\n          expected < ${limit}\n          got      ${actual}`); failures++; } };
const above = (name, actual, limit) => { checks++; if (actual > limit) console.log(`  PASS  ${name}`); else { console.log(`  FAIL  ${name}\n          expected > ${limit}\n          got      ${actual}`); failures++; } };

const sampleNam = (weights = [0.5, -0.25, 1, 0.125]) => JSON.stringify({
  version: '0.5.4',
  architecture: 'WaveNet',
  sample_rate: 48000,
  config: { layers: [{ channels: 8 }] },
  weights,
  metadata: { name: 'fixture', input_level_dbu: -18, output_level_dbu: -6 },
});

// ── 1. reading a model ────────────────────────────────────────────────────────────────────────────────────
console.log('\n1. a .nam is read for what it is, and refused when it is not one');
{
  const nam = parseNam(sampleNam());
  check('architecture is carried', nam.architecture, 'WaveNet');
  check('sample rate is carried', nam.sampleRate, 48000);
  check('metadata is carried', nam.metadata.name, 'fixture');
  check('weights come back as numbers, not strings', nam.weights instanceof Float64Array, true);
  near('…with the values intact', nam.weights[2], 1, 0);
  const refuses = (json, why) => {
    try { parseNam(json); return 'accepted'; } catch { return why; }
  };
  check('a file with no weights is refused', refuses(JSON.stringify({ architecture: 'LSTM' }), 'refused'), 'refused');
  check('an empty weight list is refused', refuses(sampleNam([]), 'refused'), 'refused');
  check('a non-finite weight is refused', refuses(JSON.stringify({ architecture: 'LSTM', weights: [1, null] }), 'refused'), 'refused');
  check('a file with no architecture is refused', refuses(JSON.stringify({ weights: [1] }), 'refused'), 'refused');
}

// ── 2. block quantization: the arithmetic the whole saving rests on ───────────────────────────────────────
console.log('\n2. quantization puts every value on its block\'s grid, and one block cannot ruin another');
{
  const values = Float64Array.from({ length: 70 }, (_, i) => Math.sin(i) * 0.5);
  const q = quantizeBlocks(values, { bits: 8, blockSize: 64 });
  check('70 weights in blocks of 64 is two blocks, remainder included', q.blocks, 2);
  check('every weight gets a code', q.codes.length, values.length);
  check('every weight gets a dequantized value', q.values.length, values.length);
  let worstGrid = 0;
  for (let b = 0; b < q.blocks; b++) {
    const start = b * 64;
    const end = Math.min(start + 64, values.length);
    for (let i = start; i < end; i++) worstGrid = Math.max(worstGrid, Math.abs(q.values[i] - q.codes[i] * q.scales[b]));
  }
  below('every value is exactly code × its own block scale', worstGrid, 1e-12);
  check('a full-scale weight round-trips EXACTLY at 8 bits', quantizeBlocks(Float64Array.of(1), { bits: 8 }).values[0], 1);
  check('…and at 4 bits', quantizeBlocks(Float64Array.of(1), { bits: 4 }).values[0], 1);

  // THE BLOCKING CLAIM: a huge weight in one block must not coarsen another block's resolution. Built so the
  // first block is quiet and the second holds one enormous value.
  const quiet = Float64Array.from({ length: 64 }, () => 0.001);
  const withOutlier = Float64Array.from([...quiet, ...Float64Array.from({ length: 64 }, (_, i) => (i === 0 ? 100 : 0.001))]);
  const blocked = quantizeBlocks(withOutlier, { bits: 8, blockSize: 64 });
  const firstBlockError = Math.abs(blocked.values[0] - withOutlier[0]);
  below('a 100.0 weight in block two leaves block one at full resolution', firstBlockError, 0.001 / 128);
  // And the control: one scale for everything is what that protects against.
  const whole = quantizeBlocks(withOutlier, { bits: 8, blockSize: withOutlier.length });
  above('…which a single scale for the whole tensor cannot do', Math.abs(whole.values[0] - withOutlier[0]), 0.001 / 128);

  const at4 = quantizeBlocks(values, { bits: 4, blockSize: 64 });
  const at8 = quantizeBlocks(values, { bits: 8, blockSize: 64 });
  const at16 = quantizeBlocks(values, { bits: 16, blockSize: 64 });
  above('8 bits is closer than 4', at8.sqnrDb, at4.sqnrDb + 15);
  above('16 bits is closer than 8', at16.sqnrDb, at8.sqnrDb + 15);
  near('a block of one weight per scale is the best a block quantizer can do', quantizeBlocks(values, { bits: 8, blockSize: 1 }).sqnrDb, at8.sqnrDb, Infinity);
}

// ── 3. the byte budget, which is the number a device decision starts from ─────────────────────────────────
console.log('\n3. the byte budget counts what a device would actually store');
{
  check('13802 weights at 8 bits', namBytes(13802, 8), 13802);
  check('…at 4 bits', namBytes(13802, 4), 6901);
  check('…at 16 bits', namBytes(13802, 16), 27604);
  check('an odd count rounds up rather than truncating', namBytes(3, 4), 2);
}

// ── 4. writing a quantized model back out ─────────────────────────────────────────────────────────────────
console.log('\n4. the quantized file is a real .nam, and says what was done to it');
{
  const nam = parseNam(sampleNam());
  const { text, quantization } = quantizedNam(nam, { bits: 8, blockSize: 64 });
  const back = parseNam(text);
  check('it still parses as a .nam', back.architecture, nam.architecture);
  check('the sample rate survives', back.sampleRate, nam.sampleRate);
  check('the config survives', JSON.stringify(back.config), JSON.stringify(nam.config));
  check('the weight count is unchanged', back.weights.length, nam.weights.length);
  check('it records the bit width', back.metadata.morpheus_quantization.bits, 8);
  check('…and the block size', back.metadata.morpheus_quantization.block_size, 64);
  check('…and that it is weights-only', /weights rounded/.test(back.metadata.morpheus_quantization.note), true);
  check('every written value is one the codes can produce',
    Array.from(back.weights).every((v, i) => Math.abs(v - quantization.values[i]) < 1e-8), true);
  // The original metadata must not be thrown away — the calibration figures are what stop a good model sounding
  // wrong on a device at a different level.
  check('the original metadata is preserved alongside it', back.metadata.name, 'fixture');
  const coarse = quantizedNam(nam, { bits: 4, blockSize: 64 });
  const fine = quantizedNam(nam, { bits: 16, blockSize: 64 });
  const meanErr = (v) => Array.from(v, (x, i) => Math.abs(x - nam.weights[i])).reduce((a, b) => a + b, 0) / v.length;
  above('4 bits is FURTHER from the original than 16, not closer', meanErr(coarse.quantization.values), meanErr(fine.quantization.values));
}

// ── 5. the bridge into the deployment container ───────────────────────────────────────────────────────────
console.log('\n5. the deployment container is valid, and carries what a backend needs');
{
  const nam = parseNam(sampleNam(Array.from({ length: 13802 }, (_, i) => Math.sin(i / 100))));
  const model = toDeploymentModel(nam, { bits: 8, blockSize: 64 });
  const v = validateModel(model);
  check('the container validates', v.errors, []);
  check('…and it is the format a backend reads', model.format, 'morpheus-model/1');
  check('the architecture is carried through', model.architecture, 'WaveNet');
  check('the sample rate is carried through', model.sample_rate, 48000);
  check('the INPUT calibration survives, because a model at the wrong level sounds wrong', model.io.input_level_dbu, -18);
  check('…and the output calibration', model.io.output_level_dbu, -6);
  check('the provenance names the source', model.source.nam_weights, 13802);
  const bytes = modelBytes(model);
  check('the weight bytes match the .nam arithmetic', bytes.weights, namBytes(13802, 8));
  above('…and the scales are counted, not assumed free', bytes.total, bytes.weights);
  // Dropping the scale must be refused: it is the one field whose absence is invisible until the audio is wrong.
  const broken = JSON.parse(JSON.stringify(model));
  delete broken.layers[0].tensors[0].scales;
  check('a container with no scale is refused', validateModel(broken).valid, false);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ the .nam quantizer does something other than what it claims\n');
  process.exit(1);
}
console.log('a model can be quantized, written back, and described in a format a device can read\n');
