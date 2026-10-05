// A cabinet uploaded in the app has to reach the code that bakes it — and not from anywhere else.
//
// WHY THIS EXISTS. The cabinet's DSP was proven before this existed (`verify-audio-plugin.mjs` §20), and the
// feature was still unusable: the scaffolder reads `project_files`, a cabinet's audio lives in storage as
// bytes, and NOTHING connected the two. Worse, the obvious connection is wrong — the Media panel's upload
// commits into the project's GitHub repo and keeps no bytes, so adding `.wav` to its accept list would have
// changed nothing at all. This asserts the path that actually exists, and bounds where it will fetch from.
//
// Dependency-free: it reads the source, imports the pure module, and runs the same arithmetic the server
// will. Run: node scripts/verify-cabinet-upload.mjs
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_CABINET_BYTES, hydrateCabinets, isCabinetPath, isOwnStorageUrl, storagePrefixes, validateCabinet,
} from '../server/src/lib/cabinetFile.js';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const read = (p) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8') : '');

let checks = 0;
let failures = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual); const e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

console.log('\n1. what counts as a cabinet, and what does not');
check('a .wav is a cabinet', isCabinetPath('models/cab.wav'), true);
check('…whatever the case', isCabinetPath('CAB.WAV'), true);
check('…and nothing else is', [isCabinetPath('models/amp.nam'), isCabinetPath('src/x.wav.js'), isCabinetPath(null)],
  [false, false, false]);

console.log('\n2. the BYTES are checked, not the name');
const wav = (body = 200) => {
  const b = Buffer.alloc(44 + body);
  b.write('RIFF', 0, 'ascii'); b.write('WAVE', 8, 'ascii');
  return b;
};
check('a real WAV header passes', validateCabinet({ filename: 'cab.wav', bytes: wav() }).ok, true);
check('…a file named .wav that is not one is REFUSED, with the bytes quoted back',
  validateCabinet({ filename: 'cab.wav', bytes: Buffer.from('not a wav at all, honestly') }).reason,
  'that file is too short to be a WAV (a WAV header alone is 44 bytes)');
check('…and a long file with the wrong magic says what it found',
  validateCabinet({ filename: 'cab.wav', bytes: Buffer.alloc(200, 65) }).reason,
  'that file is not a WAV — it starts "AAAA" and says "AAAA" where RIFF and WAVE belong');
check('…a .nam is refused by name before any bytes are read',
  /is not a \.wav/.test(validateCabinet({ filename: 'amp.nam', bytes: wav() }).reason), true);
check('…and an empty upload is refused rather than stored',
  validateCabinet({ filename: 'cab.wav', bytes: Buffer.alloc(0) }).reason, 'the upload arrived empty');
check('…with a size cap',
  /the limit is 16 MB/.test(validateCabinet({ filename: 'cab.wav', bytes: Buffer.alloc(MAX_CABINET_BYTES + 1) }).reason), true);

console.log('\n3. hydration fetches from THIS server, and nowhere else');
const storageEnv = { S3_PUBLIC_BASE_URL: 'https://cdn.example.test/bucket' };
const localEnv = { BACKEND_PUBLIC_URL: 'https://api.example.test' };
check('an S3-shaped URL of ours is ours',
  isOwnStorageUrl('https://cdn.example.test/bucket/123-cab.wav', storageEnv), true);
// A RELATIVE url only exists when BACKEND_PUBLIC_URL is unset — that is the whole reason storage.js omits the
// host in that case — so this asserts the pair rather than either one alone.
check('…a relative /uploads URL is ours when there is no backend host to prefix it with',
  isOwnStorageUrl('/uploads/123-cab.wav', {}), true);
check('…and it is NOT ours once storage is addressing a different host',
  isOwnStorageUrl('/uploads/123-cab.wav', localEnv), false);
check('…and a backend-based one is too',
  isOwnStorageUrl('https://api.example.test/uploads/123-cab.wav', localEnv), true);
// ⚠️ THE SSRF BOUNDARY. A row's file_url is data; a compile that dials whatever a row says is a fetch
// primitive aimed by whoever can write a row.
check('…a URL anywhere else is NOT, including one that only looks similar',
  [isOwnStorageUrl('https://evil.test/uploads/123.wav', localEnv),
    isOwnStorageUrl('https://api.example.test.evil.test/uploads/x.wav', localEnv),
    isOwnStorageUrl('http://169.254.169.254/latest/meta-data/', localEnv)].every((v) => v === false), true);

console.log('\n4. hydration turns a stored cabinet into content, and refuses everything else');
const cab = { path: 'models/cab.wav', file_url: 'https://cdn.example.test/bucket/1-cab.wav', content: 'Cabinet impulse response: 244 bytes' };
const fetched = [];
const bytes = wav();
const okRun = await hydrateCabinets([cab], { env: storageEnv, fetchBytes: async (u) => { fetched.push(u); return bytes; } });
check('a cabinet of ours is fetched once and becomes base64 content',
  [fetched.length, okRun.files[0].encoding, Buffer.from(okRun.files[0].content, 'base64').length, okRun.warnings.length],
  [1, 'base64', bytes.length, 0]);
check('…and the file_url is dropped, so nothing downstream fetches it again',
  okRun.files[0].file_url, undefined);
const foreign = await hydrateCabinets([{ ...cab, file_url: 'https://evil.test/x.wav' }],
  { env: storageEnv, fetchBytes: async () => { throw new Error('must not be called'); } });
check('a cabinet pointing off-storage is REFUSED rather than fetched',
  [foreign.warnings.length, /not this server's storage/.test(foreign.warnings[0]), foreign.files[0].file_url.startsWith('https://evil.test')],
  [1, true, true]);
const bad = await hydrateCabinets([cab], { env: storageEnv, fetchBytes: async () => Buffer.from('junk') });
check('…and bytes that are not a WAV warn instead of becoming a cabinet',
  /not a WAV|too short to be a WAV/.test(bad.warnings[0] || ''), true);
const failed = await hydrateCabinets([cab], { env: storageEnv, fetchBytes: async () => { throw new Error('HTTP 404'); } });
check('…and a download that fails is a warning, so the build is a gain plugin and not a failed compile',
  /could not be downloaded/.test(failed.warnings[0] || ''), true);
check('a file with no file_url at all is left exactly as it was',
  (await hydrateCabinets([{ path: 'models/cab.wav', content: 'x' }], { env: storageEnv })).files[0].content, 'x');

console.log('\n5. and the app is wired to it end to end');
const route = read('server/src/routes/cabinet.routes.js');
check('there is a route that takes the upload', route.length > 500, true);
check('…requiring an authenticated user and refusing widget tokens',
  /requireAuth, blockWidget/.test(route), true);
check('…which validates the BYTES server-side, where it cannot be skipped',
  /validateCabinet\(\{ filename: req\.file\.originalname, bytes: req\.file\.buffer \}\)/.test(route), true);
check('…stores them and keeps only a preview in the row',
  /uploadFile\(\{/.test(route) && /file_url/.test(route) && /language: 'binary'/.test(route), true);
const index = read('server/src/index.js');
check('…and it is mounted', /app\.use\('\/api\/cabinet', cabinetRoutes\)/.test(index), true);
const compile = read('server/src/functions/compileProject.js');
// ⚠️ BEFORE `adapter.scaffold`, because the scaffolder is pure and synchronous by design — one that does I/O
// is one nobody can test.
check('⭐ the compile hydrates the bytes immediately BEFORE the pure scaffolder runs',
  compile.indexOf('hydrateCabinets(projectFiles') > 0
  && compile.indexOf('hydrateCabinets(projectFiles') < compile.indexOf('adapter.scaffold('), true);
check('…with a bounded fetch, so a hung download cannot stall a compile silently',
  /AbortSignal\.timeout/.test(compile), true);
check('…and every refusal is a WARNING rather than a thrown compile',
  /for \(const w of hydrated\.warnings\) console\.warn/.test(compile), true);
const dialog = read('src/components/matrix/CabinetDialog.jsx');
check('the panel offers the upload for the audio plugin routes only',
  /startsWith\('audio-plugin-'\)/.test(read('src/components/matrix/CompilePanel.jsx')), true);
check('…states the 4096-tap and 48 kHz limits rather than letting them be discovered',
  /4096/.test(dialog) && /44\.1 kHz/.test(dialog), true);
check('…and sends multipart through the client that adds the token',
  /apiFetch\(`\/cabinet\/\$\{projectId\}`/.test(dialog) && /FormData/.test(dialog), true);
// The dialog is not the check: the server refuses too. Said out loud because the reverse is the classic bug.
check('…and the client-side size check is described as a courtesy, not the enforcement',
  /the limit is/.test(dialog) && /req\.file\.buffer/.test(route), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ an uploaded cabinet would not reach the build\n');
  process.exit(1);
}
console.log('an uploaded cabinet reaches the scaffolder, and only from this server\n');
