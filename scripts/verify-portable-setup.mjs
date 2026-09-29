// Does the Portable Morpheus installer hold up its end?
//
// WHY THIS EXISTS. Portable Morpheus is a download that has to end with a server running on someone
// else's machine — a much harder promise to keep honest than the hosted app, because nobody here can
// see what it did. Two failure modes cost a stranger their evening: a setup that needs a database
// nobody installed, and a setup that claims a finished product. So this asserts:
//
//   1. the RULE — the secrets a local install generates, the .env it writes, the steps it takes, and
//      the list of what it does NOT do (asserted, so the honest list cannot quietly go stale);
//   2. DELEGATION — the database comes from `server/scripts/dev-db.mjs`, which already drives real
//      Postgres binaries. A second mechanism is exactly how the portable download ended up shipping a
//      tree a month out of date, so the installer is asserted not to grow one;
//   3. SAFETY — it never overwrites an existing .env (that file holds the key that decrypts stored
//      connection credentials), never prints a secret, and never writes anything in `--check`.
//
// Dependency-free, so it runs in CI's no-install guards job. The post-mortem it defends against is in
// server/src/lib/portableBundle.js.
//
// Run:  node scripts/verify-portable-setup.mjs
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REQUIRED_NODE_MAJOR, LOCAL_DB, GENERATED_ENV, LOCAL_ENV, INSTALL_STEPS, NOT_INSTALLED_YET,
  preflight, generateSecrets, envFileContents, localUrl, redactEnvLine, DEV_DB_URL_PATTERN,
} from '../server/src/lib/portableSetup.js';
import { selectPortableFiles } from '../server/src/lib/portableBundle.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

console.log('\n1. preflight refuses to half-install');
check('a supported Node and platform passes', preflight({ nodeMajor: REQUIRED_NODE_MAJOR, platform: 'darwin' }).ok, true);
const old = preflight({ nodeMajor: REQUIRED_NODE_MAJOR - 1, platform: 'linux' });
check('an old Node is refused, and says why', [old.ok, /Node \d+\+ is required/.test(old.problems[0])].join(','), 'false,true');
check('a platform with no Postgres binaries is refused, with the way out',
  /existing DATABASE_URL/.test(preflight({ nodeMajor: 22, platform: 'sunos' }).problems[0]), true);

console.log('\n2. the secrets a stranger cannot invent');
const s1 = generateSecrets((n) => Buffer.alloc(n, 1));
const s2 = generateSecrets((n) => Buffer.alloc(n, 2));
check('ENCRYPTION_KEY decodes to exactly the 32 bytes lib/crypto.js demands',
  Buffer.from(s1.ENCRYPTION_KEY, 'base64').length, 32);
check('JWT_SECRET is real entropy, not a placeholder', s1.JWT_SECRET.length >= 60, true);
check('two installs get different secrets', s1.JWT_SECRET === s2.JWT_SECRET, false);
check('the database URL is LOCAL — dev-db.mjs refuses anything else',
  /@127\.0\.0\.1:/.test(s1.DATABASE_URL) && new RegExp(`:${LOCAL_DB.port}/`).test(s1.DATABASE_URL), true);
// Measured, not assumed: the first version of this URL had no password, and a real install got three
// steps in before dev-db.mjs rejected it with "Could not parse DATABASE_URL". The contract is that
// script's own parser, so this asserts the generated URL against DEV_DB_URL_PATTERN AND that the
// script still contains that exact pattern — a copy in the guard alone would drift from the real
// parser and pass while the installer broke.
const parsed = new RegExp(DEV_DB_URL_PATTERN).exec(s1.DATABASE_URL);
check('the generated URL satisfies dev-db.mjs\'s parser', Array.isArray(parsed), true);
check('…and dev-db.mjs still uses that same pattern', read('server/scripts/dev-db.mjs').includes(DEV_DB_URL_PATTERN), true);
check('the password is URL-safe, so no random draw can break the URL',
  /^[A-Za-z0-9_-]+$/.test(parsed ? parsed[2] : ''), true);
check('the local cluster gets a real password, not an empty one', (parsed ? parsed[2].length : 0) >= 20, true);

console.log('\n3. the .env says what is true');
const env = envFileContents({ secrets: s1 });
check('every generated value is written', GENERATED_ENV.every((g) => env.includes(`${g.key}=`)), true);
check('…including the port the server actually listens on', env.includes(`PORT=${LOCAL_ENV.PORT}`), true);
check('AI is present but EMPTY, not pretended', /LLM_BASE_URL=\nLLM_API_KEY=\nLLM_MODEL=/.test(env), true);
check('…and the three sources are named for the operator to choose', /locally hosted model[\s\S]*your own provider key[\s\S]*Morpheus account/.test(env), true);
check('it warns the file holds secrets and must not be shared', /do not commit it/.test(env) && /chat or an issue/.test(env), true);
check('Google/GitHub sign-in is stated as off, with the reason (no stable hostname)',
  /Google and GitHub sign-in are OFF/.test(env) && /redirect URIs/.test(env), true);

console.log('\n4. the honest list of what is not there yet');
check('it names remote access', NOT_INSTALLED_YET.some((n) => /Remote access/i.test(n)), true);
check('…and that the paid AI default cannot work out of the box yet, naming the broker',
  NOT_INSTALLED_YET.some((n) => /broker/i.test(n) && /not deployed/i.test(n)), true);
check('…and that this is not a double-clickable installer', NOT_INSTALLED_YET.some((n) => /native app or installer/i.test(n)), true);
check('the steps are a real sequence, not a sentence', INSTALL_STEPS.length >= 6 && INSTALL_STEPS.every((s) => s.id && s.title), true);
check('the URL the install ends at is named', localUrl(), `http://localhost:${LOCAL_ENV.PORT}`);

console.log('\n5. the database is DELEGATED, never re-implemented');
const setup = read('scripts/portable-setup.mjs');
check('the installer runs server/scripts/dev-db.mjs', /dev-db\.mjs/.test(setup) && /\[DEV_DB, 'start'\]/.test(setup), true);
check('…and applies the schema through it too', /\[DEV_DB, 'schema'\]/.test(setup), true);
check('…and refuses to continue if that script is missing', /delegates to it rather than starting/.test(setup), true);
// The mechanism this must not grow: driving the binaries itself.
check('it does NOT drive initdb/pg_ctl itself', /['"`](initdb|pg_ctl)['"`]/.test(setup), false);
check('…and does not import embedded-postgres', /embedded-postgres/.test(setup), false);

console.log('\n6. it is safe to run');
const checkBlock = setup.indexOf('if (CHECK) {');
const firstWrite = setup.indexOf('writeFileSync(ENV_PATH');
check('--check exits before anything is written', checkBlock > 0 && checkBlock < firstWrite, true);
check('an existing .env is left alone (the key that decrypts stored credentials)',
  /if \(existsSync\(ENV_PATH\)\)[\s\S]{0,500}?writeFileSync\(ENV_PATH/.test(setup), true);
check('secrets are never printed', /console\.log\([^)]*secrets\./.test(setup), false);
check('…and the redactor exists for anything that must be shown', redactEnvLine('ENCRYPTION_KEY=abc').includes('<generated'), true);
check('the .env is written 0600', /mode: 0o600/.test(setup), true);

console.log('\n7. the server hosts the frontend itself, so there is no second process');
const index = read('server/src/index.js');
check('local mode is gated on a built frontend existing',
  /if \(existsSync\(path\.join\(PORTABLE_DIST, 'index\.html'\)\)\)/.test(index), true);
check('…which makes it a no-op on the hosted deployment (no dist in the backend image)',
  /the backend image has no dist\//.test(index), true);
check('the Deck is routed to deck.html for deep links', /app\.get\(\/\^\\\/deck/.test(index), true);
check('API paths are not swallowed by the SPA fallback', /\(\?!api\\\/\)/.test(index), true);

console.log('\n8. the bundle carries the installer and its rule');
const walk = (dir, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.'))) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile()) out.push(relative(ROOT, full).split(sep).join('/'));
  }
  return out;
};
const inBundle = selectPortableFiles(walk(ROOT));
check('scripts/portable-setup.mjs ships', inBundle.includes('scripts/portable-setup.mjs'), true);
check('server/src/lib/portableSetup.js ships', inBundle.includes('server/src/lib/portableSetup.js'), true);
check('server/scripts/dev-db.mjs ships — the installer is useless without it',
  inBundle.includes('server/scripts/dev-db.mjs'), true);

console.log('\n9. the authority reports it');
check('reality.mjs knows about the local setup', /one-command local setup|portable-setup/i.test(read('scripts/reality.mjs')), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ a stranger could be left with a setup that cannot finish, or one that overclaims\n');
  process.exit(1);
}
console.log('the portable installer finishes the job, delegates the database, and says what it lacks\n');
