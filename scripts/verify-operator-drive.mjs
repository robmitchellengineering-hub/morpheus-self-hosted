// Verification for the operator token — the credential scripts/morpheus.mjs
// drives self-dev with.
//
// Two halves, both necessary:
//
//   1. BEHAVIOUR of the pure rules (server/src/lib/operatorToken.js): what may
//      be called, what gets stripped, and that a wrong token is a clean false
//      rather than a throw or a leak.
//   2. STRUCTURE of the two places that enforce it (the route and the CLI):
//      that the operator branch really is narrower than requireAuth, that the
//      only body a handler ever receives is the stripped one, that the CLI
//      cannot print the token, and that no token value has been committed.
//
// A guard that only did (1) would pass while the route forwarded `force`; a
// guard that only did (2) would pass while the comparison leaked. Run:
//   node scripts/verify-operator-drive.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OPERATOR_TOKEN_PREFIX, OPERATOR_TOKEN_ENV, OPERATOR_SCOPE_FUNCTIONS, OPERATOR_FORBIDDEN_FIELDS,
  OPERATOR_DAILY_TURN_CAP, operatorTokenConfigured, isOperatorToken, hashOperatorToken,
  verifyOperatorToken, operatorMayCall, stripOperatorEscapeHatches, operatorWithinDailyCap,
  operatorTokenFingerprint,
} from '../server/src/lib/operatorToken.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const read = (rel) => readFileSync(path.join(REPO, rel), 'utf8');

let failures = 0;
let checks = 0;

function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  PASS  ${name}`);
  } else {
    console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`);
    failures++;
  }
}

console.log('\noperator token — verification\n');

// ── 1. What the token may call ──────────────────────────────────────────────
console.log('1. the allow-list is exactly what was agreed');

// Pinned as a literal so that widening the credential's power is always a
// deliberate edit to two files, never a side effect of adding a function.
const EXPECTED_SCOPE = [
  'chatWithMorpheus', 'getSelfDevDecisions', 'getSelfDevFeatures', 'importSelfDevRepo',
  'mergeSelfDevPr', 'pushSelfDevToGithub', 'smokeCheckSelfDev', 'verifySelfDev',
].sort();
check('OPERATOR_SCOPE_FUNCTIONS is unchanged', [...OPERATOR_SCOPE_FUNCTIONS].sort(), EXPECTED_SCOPE);

// The four that must never be reachable, each for a different reason.
const MUST_BE_UNREACHABLE = ['revertSelfDevPush', 'applySelfDevMigrations', 'buildDeckWidget', 'generateRebuildDoc', 'synthesizeUpdatesPlan', 'generateSelfDevPrototype', 'generateSelfDevManual'];
for (const fn of MUST_BE_UNREACHABLE) check(`${fn} is not in scope`, operatorMayCall(fn), false);

check('an unknown function is refused', operatorMayCall('definitelyNotAFunction'), false);
check('undefined is refused', operatorMayCall(undefined), false);
check('every in-scope function is allowed', OPERATOR_SCOPE_FUNCTIONS.filter((f) => !operatorMayCall(f)), []);

// ── 2. Recognising a token ──────────────────────────────────────────────────
console.log('\n2. a JWT is never mistaken for an operator token');
check('prefix is the documented one', OPERATOR_TOKEN_PREFIX, 'opr_');
check('accepts a well-formed token', isOperatorToken(`${OPERATOR_TOKEN_PREFIX}${'a'.repeat(48)}`), true);
check('rejects a JWT', isOperatorToken('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature'), false);
check('rejects a bare prefix', isOperatorToken(OPERATOR_TOKEN_PREFIX), false);
check('rejects a too-short token', isOperatorToken(`${OPERATOR_TOKEN_PREFIX}abc`), false);
check('rejects a widget token', isOperatorToken(`wgt_${'a'.repeat(48)}`), false);
check('rejects empty', isOperatorToken(''), false);
check('rejects null', isOperatorToken(null), false);

// ── 3. Comparison ───────────────────────────────────────────────────────────
console.log('\n3. comparison is constant-time, and a wrong token is a clean false');
const GOOD = `${OPERATOR_TOKEN_PREFIX}0123456789abcdef0123456789abcdef0123456789abcdef`;
const env = { [OPERATOR_TOKEN_ENV]: hashOperatorToken(GOOD) };
check('the right token verifies', verifyOperatorToken(GOOD, env), true);
check('a wrong token fails', verifyOperatorToken(`${OPERATOR_TOKEN_PREFIX}${'f'.repeat(48)}`, env), false);
check('a same-length wrong token fails', verifyOperatorToken(`${OPERATOR_TOKEN_PREFIX}${'0'.repeat(48)}`, env), false);
check('an empty value fails', verifyOperatorToken('', env), false);
check('undefined fails without throwing', verifyOperatorToken(undefined, env), false);
check('an UNSET deployment refuses everything', verifyOperatorToken(GOOD, {}), false);
check('a MALFORMED hash refuses everything (no throw)', verifyOperatorToken(GOOD, { [OPERATOR_TOKEN_ENV]: 'not-a-hash' }), false);
check('a short length is refused by operatorTokenConfigured', operatorTokenConfigured({ [OPERATOR_TOKEN_ENV]: 'abcd' }), false);
check('a real 64-hex hash is accepted', operatorTokenConfigured(env), true);

// ── 4. The escape hatches ───────────────────────────────────────────────────
console.log('\n4. every documented way around a gate is stripped');
check('the four fields are the documented four', OPERATOR_FORBIDDEN_FIELDS, ['force', 'directToMain', 'acknowledgeDrift', 'scopePolicy']);

const request = { message: 'x', force: true, directToMain: true, acknowledgeDrift: true, scopePolicy: 'widget_build', keep: 1 };
const strippedRequest = stripOperatorEscapeHatches(request);
check('force is gone', strippedRequest.body.force, undefined);
check('directToMain is gone', strippedRequest.body.directToMain, undefined);
check('acknowledgeDrift is gone', strippedRequest.body.acknowledgeDrift, undefined);
check('scopePolicy is gone (a scoped push is exempt from the drift guard)', strippedRequest.body.scopePolicy, undefined);
check('ordinary fields survive', { message: strippedRequest.body.message, keep: strippedRequest.body.keep }, { message: 'x', keep: 1 });
check('the stripped names are reported for the audit row', strippedRequest.stripped.sort(), ['acknowledgeDrift', 'directToMain', 'force', 'scopePolicy']);
check('the caller\'s object is not mutated', request.force, true);
check('a null body is tolerated', stripOperatorEscapeHatches(null).body, {});
check('an array body is tolerated', stripOperatorEscapeHatches([1, 2]).body, {});

// ── 5. The spend ceiling ────────────────────────────────────────────────────
console.log('\n5. a runaway client cannot spend without limit');
check('a sane ceiling exists', OPERATOR_DAILY_TURN_CAP > 0 && OPERATOR_DAILY_TURN_CAP <= 200, true);
check('under the cap', operatorWithinDailyCap(OPERATOR_DAILY_TURN_CAP - 1), true);
check('at the cap — refused', operatorWithinDailyCap(OPERATOR_DAILY_TURN_CAP), false);
check('over the cap — refused', operatorWithinDailyCap(OPERATOR_DAILY_TURN_CAP + 5), false);
check('an unreadable count is treated as zero, not as unlimited', operatorWithinDailyCap(undefined), true);

// ── 6. The fingerprint never contains the token ─────────────────────────────
console.log('\n6. only a fingerprint is ever printable');
const fingerprint = operatorTokenFingerprint(GOOD);
check('the fingerprint does not contain the token', fingerprint.includes(GOOD), false);
check('the fingerprint does not contain the token body', fingerprint.includes(GOOD.slice(OPERATOR_TOKEN_PREFIX.length)), false);
check('the fingerprint is stable', fingerprint, operatorTokenFingerprint(GOOD));

// ── 7. The route enforces it ────────────────────────────────────────────────
console.log('\n7. the route applies the narrow gate, and nowhere else does');
const route = read('server/src/routes/functions.routes.js');
const operatorStart = route.indexOf('async function handleOperatorCall');
const operatorEnd = route.indexOf('async function runFunction');
const handler = operatorStart >= 0 && operatorEnd > operatorStart ? route.slice(operatorStart, operatorEnd) : '';

check('handleOperatorCall exists', operatorStart >= 0, true);
check('the operator branch is recognised before requireAuth',
  route.indexOf('if (isOperatorToken(bearer))') >= 0
  && route.indexOf('if (isOperatorToken(bearer))') < route.indexOf('return requireAuth(req, res, () => {'), true);
check('the scope is enforced', handler.includes('operatorMayCall(name)'), true);
check('an unconfigured deployment refuses', handler.includes('operatorTokenConfigured()'), true);
check('the token is verified, not merely present', handler.includes('verifyOperatorToken(bearer)'), true);
check('the handler receives only the stripped body', handler.includes('const { body, stripped } = stripOperatorEscapeHatches(req.body);'), true);
check('the body it dispatches is built from the stripped one', handler.includes('req.body = { ...body,'), true);
check('it never re-reads the raw body into req.body', /req\.body\s*=\s*\{?\s*\.\.\.req\.body/.test(handler), false);
check('the project is pinned to the self-dev workspace', handler.includes('projectId: project.id'), true);
check('it acts as the self-dev owner', handler.includes('resolveSelfDevActor'), true);
check('every call is audited', handler.includes("action: 'operator_token_call'"), true);
check('chat turns are capped', handler.includes('operatorWithinDailyCap'), true);
check('the constant-time compare is used', read('server/src/lib/operatorToken.js').includes('timingSafeEqual'), true);
check('the token is never logged by the route', /console\.\w+\([^)]*bearer(?![^)]*Fingerprint)/.test(handler), false);

// ── 8. The CLI cannot widen its own power, or leak ──────────────────────────
console.log('\n8. the CLI sends no escape hatch and prints no token');
const cli = read('scripts/morpheus.mjs');
// Comments are prose. "No force: this merges only when the checks pass" is a
// sentence, not an object literal, so the scan below reads code with the
// comments taken out — the first cut of this guard failed on exactly that line.
const cliCode = cli.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
check('the CLI never sends force', /force\s*:/.test(cliCode), false);
check('the CLI never sends directToMain', /directToMain\s*:/.test(cliCode), false);
check('the CLI never sends acknowledgeDrift', /acknowledgeDrift\s*:/.test(cliCode), false);
check('the CLI never sends scopePolicy', /scopePolicy\s*:/.test(cliCode), false);
check('the CLI reuses the shared fingerprint rather than printing the token',
  cli.includes('operatorTokenFingerprint'), true);
const tokenOnAConsoleLine = cli.split('\n')
  .filter((l) => l.includes('console.') && /\bTOKEN\b/.test(l) && !l.includes('operatorTokenFingerprint'));
check('no console line prints the token', tokenOnAConsoleLine, []);
check('the CLI treats a direct push as a failure of the credential, not a success', cli.includes("b.mode === 'direct'"), true);

// ── 9. Nothing has been committed ───────────────────────────────────────────
console.log('\n9. no token value is in the repo');
const gitignore = read('.gitignore');
check('.env.* is ignored, so server/.env.morpheusops can never be committed', gitignore.includes('.env.*'), true);

const TOKEN_LIKE = new RegExp(`${OPERATOR_TOKEN_PREFIX}[0-9a-fA-F]{16,}`);
const scanned = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full);
    else if (/\.(mjs|js|jsx|md|json|txt|sh)$/.test(entry)) {
      const text = readFileSync(full, 'utf8');
      if (TOKEN_LIKE.test(text)) scanned.push(path.relative(REPO, full));
    }
  }
}
for (const dir of ['scripts', 'server/src', 'src']) walk(path.join(REPO, dir));
check('no operator token literal anywhere in the source', scanned, []);

console.log(`\n${failures === 0 ? '✓' : '✗'} ${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
