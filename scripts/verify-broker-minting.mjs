// Who may mint a Morpheus Cloud gateway token — and why the answer is not "whoever asks".
//
// WHY THIS EXISTS. The metered gateway needs a token per ACCOUNT, not per deployment, or the broker
// cannot tell whose balance to charge. So the install's own server has to mint one on behalf of the
// account it is serving, which means /api/broker/token accepts a caller that is not a user session.
// That is one conditional away from "anyone who can reach this URL can mint a token for anybody", so
// the rule lives in an import-free module (server/src/lib/brokerMinting.js) and is tested here as
// BEHAVIOUR, in CI's no-install guards job, rather than trusted to a route handler nobody re-reads.
//
// It also pins the two halves of the same protocol that live in different files:
//   * the field name hostedDefaults.js sends (`accountId`) is the one the route reads; and
//   * the response field the route sends (`token`) is the one hostedDefaults.js reads.
// A rename on either side is otherwise a 401 at the gateway, which reads like a credential problem
// rather than a typo.
//
// Run:  node scripts/verify-broker-minting.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTokenMint, mintResponse } from '../server/src/lib/brokerMinting.js';
import { mintGatewayToken, verifyGatewayToken, CLOUD_PROVIDER } from '../server/src/lib/cloudMetering.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

console.log('\n1. a session may mint for itself, and for nobody else');
check('a signed-in account gets a token for itself', resolveTokenMint({ sessionUserId: 'u1' }).accountId, 'u1');
check('…and is recorded as the session path', resolveTokenMint({ sessionUserId: 'u1' }).via, 'session');
check('naming its OWN id explicitly is fine', resolveTokenMint({ sessionUserId: 'u1', requestedAccountId: 'u1' }).accountId, 'u1');
// The escalation this module exists to refuse.
check('naming ANOTHER account is refused, not quietly redirected',
  JSON.stringify(resolveTokenMint({ sessionUserId: 'u1', requestedAccountId: 'u2' })).includes('only mint a gateway token for itself'), true);
check('…and refused with 403, so it reads as a refusal rather than a bad request',
  resolveTokenMint({ sessionUserId: 'u1', requestedAccountId: 'u2' }).status, 403);
// A session plus a broker secret is still a session: the narrower identity wins.
check('a session cannot borrow the internal path by also sending the secret',
  resolveTokenMint({ sessionUserId: 'u1', internalSecretMatches: true, requestedAccountId: 'u2' }).ok, false);

console.log('\n2. the install\'s own server may mint, with the secret, for a named account');
check('the broker secret with an account works', resolveTokenMint({ internalSecretMatches: true, requestedAccountId: 'u2' }).accountId, 'u2');
check('…and is recorded as the internal path', resolveTokenMint({ internalSecretMatches: true, requestedAccountId: 'u2' }).via, 'broker');
check('…and an internal caller that names no account is refused',
  resolveTokenMint({ internalSecretMatches: true }).status, 400);
check('an internal caller cannot mint an account of "null" literally',
  resolveTokenMint({ internalSecretMatches: true, requestedAccountId: '' }).ok, false);

console.log('\n3. nobody else gets anything');
check('no session and no secret is refused', resolveTokenMint({}).status, 401);
check('…and the refusal names authentication, not a missing field',
  resolveTokenMint({}).error, 'authentication required');
check('an empty session id is not an identity', resolveTokenMint({ sessionUserId: '' }).status, 401);
check('a null session id is not an identity', resolveTokenMint({ sessionUserId: null }).status, 401);
check('a refused mint has no accountId to leak', resolveTokenMint({}).accountId, undefined);

console.log('\n4. the response shape is the one the installer reads');
const minted = mintGatewayToken({ accountId: 'u1', secret: 'test-secret' });
check('mintResponse carries exactly the token, its expiry and the provider',
  Object.keys(mintResponse({ token: minted.token, expiresAt: minted.expiresAt, provider: CLOUD_PROVIDER })).sort().join(','),
  'expiresAt,provider,token');
check('the provider it names is the one the meter records', mintResponse({ provider: CLOUD_PROVIDER }).provider, 'morpheus-cloud');
const echoed = mintResponse({ token: minted.token, expiresAt: minted.expiresAt, provider: CLOUD_PROVIDER });
check('a token from this response verifies as the account it was minted for',
  verifyGatewayToken({ token: echoed.token, secret: 'test-secret' }).accountId, 'u1');

console.log('\n5. the route uses the rule rather than its own conditional');
const routes = code(read('server/src/routes/broker.routes.js'));
check('the token route calls resolveTokenMint', /resolveTokenMint\(\{/.test(routes), true);
check('…passing the broker-secret result, the session, and the requested account',
  ["internalSecretMatches: isBroker(req)", "sessionUserId: sessionUserIdOf(req)", "requestedAccountId: req.body?.accountId"].every((fragment) => routes.includes(fragment)), true);
check('…and answers with mintResponse, not an object literal of its own', /res\.json\(mintResponse\(\{/.test(routes), true);
check('the route is NOT behind requireAuth, which would 401 the install\'s own server',
  /router\.post\('\/token', optionalAuth,/.test(routes), true);
check('a session id comes from the optional auth middleware, so an invalid token is "no session"',
  /optionalAuth/.test(routes) && /const sessionUserIdOf = \(req\) => req\.user\?\.id \|\| null;/.test(read('server/src/routes/broker.routes.js')), true);
check('the internal path checks the account exists before minting a token that names it',
  /verdict\.via === 'broker'[\s\S]{0,220}prisma\.user\.findUnique/.test(routes), true);
check('a missing signing secret is a 503, not a token signed with an empty secret',
  /if \(!signingSecret\(\)\)[\s\S]{0,160}503/.test(routes), true);

console.log('\n6. the installer mints the same way the route expects');
const hosted = code(read('server/src/config/hostedDefaults.js'));
check('hostedDefaults POSTs to this server\'s own token endpoint', /\/api\/broker\/token/.test(hosted), true);
check('…sending the field name the route reads (`accountId`)', /body: JSON\.stringify\(\{ accountId: userId \}\)/.test(hosted), true);
check('…reading the field name the route sends (`token`)', /payload\?\.token/.test(hosted), true);
check('…and treating a failure as a failure, with the reason', /if \(!res\.ok \|\| !payload\?\.token\)/.test(hosted) && /could not mint a Morpheus Cloud gateway token/.test(hosted), true);
check('a mint is cached rather than made per call', /gatewayTokenCache/.test(hosted) && /GATEWAY_TOKEN_SKEW_MS/.test(hosted), true);
check('the cache is bounded so a long-running deployment does not accumulate accounts',
  /gatewayTokenCache\.size > 500/.test(hosted), true);
check('the minted-token path needs a signing secret to exist at all',
  /accountGatewayTokensAvailable[\s\S]{0,160}BROKER_GATEWAY_SIGNING_SECRET/.test(hosted), true);

console.log('\n7. the AI tier actually asks for the minted token');
const ai = code(read('server/src/ai.js'));
check('tier 3 no longer requires a static apiKey to exist', /const hosted = aiGatewayDefault\(\);[\s\S]{0,400}if \(!apiKey && hosted\.metered\)/.test(ai), true);
check('…and mints for the account making the call', /apiKey = await hosted\.mintForAccount\(userId\)/.test(ai), true);
check('the userId reaches resolveEndpoint, which is where the mint happens',
  /async function resolveEndpoint\(settings, role, userId\)/.test(ai) && /resolveEndpoint\(settings, role, userId\)/.test(ai), true);
check('a failed mint fails the call instead of falling through to an unmetered provider',
  /unmetered call against a billed\s*\n?\s*\/\/ gateway is refused/.test(read('server/src/ai.js')), true);
check('the static-token stopgap still works when no signing secret is set',
  /apiKey: process\.env\.MORPHEUS_AI_GATEWAY_TOKEN \|\| null/.test(hosted), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ a gateway token could be minted for an account the caller does not hold\n');
  process.exit(1);
}
console.log('a gateway token is minted per account, only by that account or by the install serving it\n');
