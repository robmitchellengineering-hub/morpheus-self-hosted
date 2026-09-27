// Runtime verification that the user's connected-service credentials are actually encrypted at rest.
//
// Dependency-free (imports the pure helper; reads the rest as source), so it runs in CI's no-install
// guards job. Run:  node scripts/verify-connection-secrets.mjs
//
// The false promise this closes (2026-09-28): `user_settings.connections` holds third-party provider
// credentials — hosting tokens, database URLs, API keys — and `schema.prisma` describes it as
// "hosting platform credentials, encrypted at rest" while the Connections UI promises the user the
// same. Both were untrue: the column was written and read as plain JSON. It matters most now that
// the product asks people to paste a hosting token into that field, on the principle that it is
// always the customer's own connection — which only holds if we are honest about their credential.
//
// The behavioural half is the important half: a guard that only greps for `encrypt(` would pass on
// code that encrypts and then hands the ciphertext to a client that JSON.parses it, which silently
// blanks every connection the user had saved.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { decodeConnections, encodeConnections } from '../server/src/lib/connectionSecrets.js';

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

const REPO = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(join(REPO, p), 'utf8');
const entities = read('server/src/entities.js');
const helper = read('server/src/lib/connectionSecrets.js');

console.log('\n1. the helper round-trips, and tolerates everything real data contains');
const sample = { netlify: { token: 'ntn_example_not_a_real_token' }, supabase: { url: 'https://x.supabase.co' } };
const encoded = encodeConnections(sample);
check('an object encodes to the encrypted form', encoded.startsWith('v1:'), true);
check('…and does not contain the plaintext', encoded.includes('ntn_example'), false);
check('…and decodes back to the same object', decodeConnections(encoded), sample);
check('decoding never returns the ciphertext as if it were the value', decodeConnections(encoded).netlify?.token === encoded, false);
// The migration-free promise: rows written before this change are plain JSON and must keep working.
const legacy = JSON.stringify(sample);
check('a legacy plaintext row still decodes (no migration needed)', decodeConnections(legacy), sample);
check('null and empty decode to {} — "connected nothing yet"', [decodeConnections(null), decodeConnections('')], [{}, {}]);
check('malformed JSON decodes to {} instead of throwing', decodeConnections('{not json'), {});
check('a non-object (an array) decodes to {}', decodeConnections('[1,2]'), {});
check('corrupt ciphertext decodes to {} instead of throwing', decodeConnections('v1:aaaa:bbbb:cccc'), {});
// Re-encoding a stored value must not double-wrap it: that would decode to a garbage string and read
// as a corrupted connection set.
check('an already-encoded value is not encrypted twice', encodeConnections(encoded), encoded);
check('null stays null on write', encodeConnections(null), null);

console.log('\n2. writes encrypt, reads decrypt, and the WIRE FORMAT does not change');
check('the entity layer encrypts this column on write',
  /if \(name === 'UserSettings'\) return writeUserSettingsSecrets\(write\(rest\)\);/.test(entities), true);
check('…and the update path does too, decrypting the echoed row',
  /return withDecryptedConnections\(await writeUserSettingsSecrets\(write\(rest\)\)\);/.test(entities), true);
// The client still receives a JSON STRING and still parses it (Settings.jsx), so the read path must
// hand back decrypted JSON — an object here, or ciphertext, would blank the user's saved connections.
check('every read of the model hands the client decrypted JSON',
  (entities.match(/rows\.map\(withDecryptedConnections\)/g) || []).length, 2);
check('…including the single-row read',
  /return name === 'UserSettings' \? withDecryptedConnections\(row\) : row;/.test(entities), true);
check('the decrypt wrapper returns a JSON string, not an object',
  /connections: JSON\.stringify\(decodeConnections\(row\.connections\)\)/.test(entities), true);
check('the direct server-side writer encrypts through the helper',
  /const connections = encodeConnections\(all\);/.test(read('server/src/functions/photoDrive.js')), true);

console.log('\n3. no reader anywhere still parses the column raw');
// Walk the server source rather than listing files, so a NEW reader is caught rather than missed.
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.js$/.test(entry)) out.push(full);
  }
  return out;
}
const offenders = walk(join(REPO, 'server', 'src'))
  .filter((f) => !f.endsWith('connectionSecrets.js'))
  .filter((f) => {
    // Comments are stripped first: this guard's own explanatory comment in entities.js quotes
    // `JSON.parse(rows[0].connections)`, and matching that prose would report a false offender —
    // the same trap an earlier guard in this repo hit.
    const src = readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^[ \t]*\/\/.*$/gm, ' ');
    // `JSON.parse(<something>.connections)` and `JSON.parse(settings.connections)` alike.
    return /JSON\.parse\([^)]*\.connections\b/.test(src);
  })
  .map((f) => relative(REPO, f));
check('no file under server/src JSON.parses the column directly', offenders.join(', '), '');

console.log('\n4. the promise and the code now agree');
check('the helper says why there is no migration, pointing at crypto.js',
  /NO MIGRATION HERE, and do not add one/i.test(helper) && /crypto\.js/.test(helper), true);
check('the schema still describes the column as encrypted at rest (now true)',
  /connections\s+String\?\s+\/\/ JSON string: hosting platform credentials, encrypted at rest/.test(read('server/prisma/schema.prisma')), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) { console.log(`${failures} FAILED\n`); process.exit(1); }
console.log('all good\n');
