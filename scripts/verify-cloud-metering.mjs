// Is the paid AI default actually PAID — does a brokered call reserve, charge and record, or does it
// only say so?
//
// WHY THIS EXISTS. `hosted-broker/` holds the operator's upstream AI key, so every self-hosted install
// that uses the default spends the operator's money. Until this change the only gate was a shared
// token list in the broker's env — no account, no balance, no cap — and the broker's own README said
// so ("swap in real per-tenant metering/billing before relying on it at any real scale"). The failure
// this guard is written against is not a crash: it is a gateway that CLAIMS to be metered while one
// path through it is free. Three such paths were found and closed while writing it, and each one has
// a check below:
//
//   1. a balance CHECK is not a reservation — two calls in flight both see a balance that covers one;
//   2. a flat-rated call re-priced per token would overcharge a 1-credit call by ~16x;
//   3. a streamed reply cannot be metered, because its token counts arrive after the caller has been
//      handed a connection nobody can take back.
//
// Dependency-free on purpose, so it runs in CI's no-install guards job: `cloudMetering.js` imports
// only `node:crypto` and the repo's `tokenHash.js`, and the broker's `metering.js` imports nothing at
// all. Both are EXECUTED here, not just read — the lesson from verify-portable-remote.mjs, where a
// wrong import passed every text assertion in the file.
//
// Run:  node scripts/verify-cloud-metering.mjs
// Configured BEFORE anything reads the environment: metering.js's instanceUrl()/instanceSecret() are
// called per request (not captured at import), but setting these here is what makes the executed
// checks below test the METERED path rather than the fallback. The unconfigured path is asserted
// explicitly in section 6.
process.env.BROKER_METERING_INSTANCE_URL = 'https://instance.test';
process.env.BROKER_METERING_SECRET = 'test-internal-secret-not-a-real-one';

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { sameToken } from '../server/src/lib/tokenHash.js';
import {
  TOKEN_PREFIX, DEFAULT_TTL_MS, RESERVATION_PREFIX, RESERVATION_TTL_MS, BROKER_SECRET_HEADER,
  CLOUD_PROVIDER, REFUSALS, METERING_CAVEATS,
  mintGatewayToken, verifyGatewayToken, mintReservationTicket, verifyReservationTicket,
  authorizeCloudCall, chargeFor, usageFromResponse, estimateCallCredits,
} from '../server/src/lib/cloudMetering.js';
import { meteringEnabled, streamingRefusal, promptCharsOf, usageFromResponse as brokerUsageFromResponse } from '../hosted-broker/src/metering.js';

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

const SECRET = 'test-signing-secret-not-a-real-one';
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const signPayload = (payload) => b64url(crypto.createHmac('sha256', SECRET).update(payload).digest());

console.log('\n1. a gateway token belongs to an account, and a wrong one is refused');
const minted = mintGatewayToken({ accountId: 'acct-1', secret: SECRET });
check('the token is prefixed like this repo\'s other bearers', minted.token.startsWith(TOKEN_PREFIX), true);
check('…and it verifies to the account that minted it', verifyGatewayToken({ token: minted.token, secret: SECRET }).accountId, 'acct-1');
check('it expires', new Date(minted.expiresAt).getTime() > Date.now(), true);
check('minting needs a secret — no accidental unsigned token', (() => { try { mintGatewayToken({ accountId: 'a' }); return 'minted'; } catch { return 'threw'; } })(), 'threw');
check('minting needs an account — no token that bills nobody', (() => { try { mintGatewayToken({ secret: SECRET }); return 'minted'; } catch { return 'threw'; } })(), 'threw');
check('a token from another deployment is refused, not trusted', verifyGatewayToken({ token: mintGatewayToken({ accountId: 'a', secret: 'other-secret' }).token, secret: SECRET }).reason, REFUSALS.signature);
check('garbage is refused as malformed', verifyGatewayToken({ token: 'not-a-token', secret: SECRET }).reason, REFUSALS.malformed);
check('a gateway token is not accepted as a reservation and vice versa',
  [verifyReservationTicket({ token: minted.token, secret: SECRET }).reason, verifyGatewayToken({ token: mintReservationTicket({ accountId: 'a', reservedCredits: 1, secret: SECRET }).token, secret: SECRET }).reason].join(','),
  `${REFUSALS.malformed},${REFUSALS.malformed}`);
check('an empty secret verifies nothing', verifyGatewayToken({ token: minted.token, secret: '' }).ok, false);

// Expiry is asserted against the clock, not trusted from the payload having an `exp` field: a token
// whose exp has passed must stop working, and forging that state is the only way to test it without
// waiting a week.
const stalePayload = b64url(JSON.stringify({ sub: 'acct-1', iat: Date.now() - 1000, exp: Date.now() - 1 }));
const stale = `${TOKEN_PREFIX}${stalePayload}.${signPayload(stalePayload)}`;
check('a correctly-signed but EXPIRED token is refused', verifyGatewayToken({ token: stale, secret: SECRET }).reason, REFUSALS.expired);
check('a payload with no readable exp is refused rather than trusted',
  verifyGatewayToken({ token: `${TOKEN_PREFIX}${b64url(JSON.stringify({ sub: 'a' }))}.${signPayload(b64url(JSON.stringify({ sub: 'a' })))}`, secret: SECRET }).reason,
  REFUSALS.malformed);
const clamped = mintGatewayToken({ accountId: 'a', secret: SECRET, ttlMs: 10 * 365 * 24 * 60 * 60 * 1000 });
check('a caller cannot mint an effectively permanent credential — TTL is clamped to 7 days',
  new Date(clamped.expiresAt).getTime() - Date.now() <= DEFAULT_TTL_MS + 1000, true);

console.log('\n2. the reservation ticket carries the amount, so the broker cannot invent one');
const ticket = mintReservationTicket({ accountId: 'acct-1', reservedCredits: 12.5, secret: SECRET });
check('it is a different kind of credential from a gateway token', ticket.token.startsWith(RESERVATION_PREFIX), true);
check('it verifies and names the account', verifyReservationTicket({ token: ticket.token, secret: SECRET }).accountId, 'acct-1');
check('it carries the reserved credits', verifyReservationTicket({ token: ticket.token, secret: SECRET }).reservedCredits, 12.5);
check('it is short-lived — minutes, not days', RESERVATION_TTL_MS <= 10 * 60 * 1000, true);
// The amount is inside the signature. A broker that wants to refund itself a fortune must re-sign,
// which needs the deployment's secret — its own env holds the internal secret, not the signing one.
const tamperedPayload = b64url(JSON.stringify({ sub: 'acct-1', rsv: 999999, jti: 'x', iat: Date.now(), exp: Date.now() + 60000 }));
const tampered = `${RESERVATION_PREFIX}${tamperedPayload}.${signPayload(b64url(JSON.stringify({ sub: 'acct-1', rsv: 12, jti: 'x', iat: Date.now(), exp: Date.now() + 60000 })))}`;
check('a ticket whose amount was edited by the broker is refused', verifyReservationTicket({ token: tampered, secret: SECRET }).reason, REFUSALS.signature);
check('a negative reservation is refused rather than minted as a refund',
  (() => { try { mintReservationTicket({ accountId: 'a', reservedCredits: -5, secret: SECRET }); return 'minted'; } catch { return 'threw'; } })(), 'threw');
check('two tickets for the same call are distinguishable, so one cannot be redeemed twice',
  mintReservationTicket({ accountId: 'a', reservedCredits: 1, secret: SECRET }).reservationId
    === mintReservationTicket({ accountId: 'a', reservedCredits: 1, secret: SECRET }).reservationId, false);

console.log('\n3. the money arithmetic is the product\'s, not a second opinion');
// chargeFor is this gateway's copy of the retail formula; billingLedger.js's expectedCharge is the
// policy the ledger check audits production rows with. Same numbers in, same credits out.
check('rate × markup ÷ $0.005, to 4 places', chargeFor({ inputTokens: 1_000_000, outputTokens: 0, inputPerM: 4, outputPerM: 0, markup: 2 }), 1600);
check('output tokens priced too', chargeFor({ inputTokens: 0, outputTokens: 500_000, inputPerM: 0, outputPerM: 8, markup: 2 }), 1600);
check('a free model costs nothing', chargeFor({ inputTokens: 999_999, outputTokens: 999_999, inputPerM: 0, outputPerM: 0, markup: 2 }), 0);
check('a missing markup cannot silently become a free call', Number.isFinite(chargeFor({ inputTokens: 1000, outputTokens: 1000, inputPerM: 4, outputPerM: 4, markup: undefined })), true);
// The reservation must be biased HIGH, like billing.js's own estimate (1.4x) — the direction of
// error has to be in the platform's favour, not the spender's.
const reserved = estimateCallCredits({ promptChars: 4000, maxTokens: 1000, inputPerM: 4, outputPerM: 8, markup: 2, safety: 1.4 });
const unBiased = chargeFor({ inputTokens: 1000, outputTokens: 1000, inputPerM: 4, outputPerM: 8, markup: 2 });
check('the reservation exceeds the equivalent exact charge', reserved > unBiased, true);
check('…and uses the product\'s own safety multiplier and heuristic passed in, not literals here',
  /ESTIMATE_SAFETY_MULTIPLIER/.test(read('server/src/lib/billing.js')) && /safety: ESTIMATE_SAFETY_MULTIPLIER/.test(read('server/src/routes/broker.routes.js')), true);
check('an unmeterable response is null, never zero tokens', usageFromResponse({}), null);
check('a zero-token response is a real count, not a missing one', JSON.stringify(usageFromResponse({ usage: { prompt_tokens: 0, completion_tokens: 0 } })), '{"inputTokens":0,"outputTokens":0}');

console.log('\n4. the app refuses to serve on a balance it only checked');
const routes = code(read('server/src/routes/broker.routes.js'));
check('verify reserves atomically rather than comparing balances', /await reserveCredits\(/.test(routes), true);
check('…and only the reservation path mints a ticket', (routes.match(/mintReservationTicket\(/g) || []).length >= 2, true);
// SCOPED to the /usage handler's own body. The first version tested the whole file, so it was
// satisfied by the identical call in /refund — a check that passed while /usage redeemed the wrong
// credential kind. It was caught by breaking the subject on purpose, which is why that is done.
const usageBody = (routes.split("router.post('/usage'")[1] || '').split("router.post('")[0];
const refundBody = (routes.split("router.post('/refund'")[1] || '').split("router.post('")[0];
check('usage redeems the TICKET, not the gateway token — a broker that skipped verify has nothing to charge',
  /verifyReservationTicket\(\{\s*token: req\.body\?\.ticket/.test(usageBody) && !/verifyGatewayToken\(/.test(usageBody), true);
check('usage reports, it does not reserve', /await reconcileCredits\(|charged = flat/.test(usageBody) && !/reserveCredits\(/.test(usageBody), true);
check('…and /refund redeems a ticket too, so a failed call is not left charged',
  /verifyReservationTicket\(\{\s*token: req\.body\?\.ticket/.test(refundBody), true);
check('an exempt account is metered but not charged — it still gets a ticket and a usage row',
  /reservedCredits: 0[\s\S]{0,400}exempt: true/.test(routes) && /creditsCharged: charged/.test(routes), true);
check('the broker authenticates with the shared secret in constant time', /isBroker\(req\)/.test(routes) && /sameToken\(/.test(routes), true);
check('the header name has one home and both halves use it',
  [code(read('server/src/routes/broker.routes.js')).includes('BROKER_SECRET_HEADER'), code(read('hosted-broker/src/metering.js')).includes("'x-morpheus-broker-secret'")].join(','),
  'true,true');
check('BROKER_SECRET_HEADER is what metering.js actually sends', BROKER_SECRET_HEADER, 'x-morpheus-broker-secret');

console.log('\n5. a brokered call is priced from its tokens, not from the flat own-key rate');
// WRITTEN AFTER THE FIRST VERSION OF THIS SECTION WAS FOOLED. It asserted that the gateway applied
// creditPolicy's flat 1-credit rule, and passed — while the live server charged a 49k-token gemini
// call 0.28 credits, because the only thing it actually matched was a comment and the identifier
// `isFlatRateCall`, which appears in the explanatory text either way. The rule the code needs is the
// opposite, and the reason is the whole point of this gateway:
//
//   * a flat 1 credit covers our PLUMBING for a call whose inference is not ours (the account's own
//     key, or a model running on their machine) — creditPolicy.js's own reasoning; but
//   * this broker holds the upstream key, so the operator pays that model's real inference bill and
//     the call must be priced from the tokens it used, like every other platform-key call.
//
// So the assertion is on the arithmetic, not on a named helper: the usage branch must convert real
// token counts to credits, and must NOT consult the flat-rate rule at all.
const usageHandler = (routes.split("router.post('/usage'")[1] || '').split("router.post('")[0];
check('usage converts the real token counts into credits', /usdToCredits\(computeCostUsd\(usage\.inputTokens, usage\.outputTokens, rate\), markup\)/.test(usageHandler), true);
check('…and true-ups the reservation against that charge', /reconcileCredits\(user\.id, verdict\.reservedCredits, charged\)/.test(usageHandler), true);
check('…and does NOT apply the flat own-key rate to a call the operator pays for',
  !/isFlatRateCall|FLAT_CALL_CREDITS/.test(usageHandler.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '')), true);
check('an exempt account is charged nothing but still recorded', /if \(!exempt\) \{/.test(usageHandler) && /creditsCharged: charged/.test(routes), true);
check('the response says how the call was priced, so a reader need not infer it', /pricedBy: exempt \? 'exempt' : 'tokens'/.test(routes), true);
// The two halves must agree about WHICH models are flat, so this cannot drift from creditPolicy.
// Against CODE, not raw text: the route explains this decision in a comment that names the rule, and
// the raw-text version of this check failed on its own prose — the same trap as the JSZip and
// initdb/pg_ctl assertions, for the fourth time in this guard's short life.
check('the flat-rate model list still has exactly one home',
  /FLAT_RATE_MODELS/.test(code(read('server/src/lib/creditPolicy.js'))) && !/FLAT_RATE_MODELS/.test(code(read('server/src/routes/broker.routes.js'))), true);

console.log('\n6. the stream is refused, because a stream cannot be metered');
const brokerServer = code(read('hosted-broker/src/server.js'));
check('metering refuses a streamed request', streamingRefusal({ stream: true }).includes('cannot be metered'), true);
check('a non-streamed request passes', streamingRefusal({ stream: false }), null);
check('the refusal text tells the caller what to do instead', /stream:false|LLM_API_KEY/.test(streamingRefusal({ stream: true })), true);
check('the passthrough calls it before spending anything',
  brokerServer.indexOf('streamingRefusalFor(req.body)') < brokerServer.indexOf('verifyCall('), true);

console.log('\n7. the broker reserves, proxies, and reports — in that order');
check('verify happens before the upstream fetch', brokerServer.indexOf('await verifyCall(') < brokerServer.indexOf('await fetch(`${upstreamBase}/chat/completions`'), true);
check('the real token counts are reported after it', brokerServer.indexOf('await reportUsage(') > brokerServer.indexOf('await fetch(`${upstreamBase}/chat/completions`'), true);
check('a call that never reached the model is refunded, not kept', (brokerServer.match(/await refundCall\(/g) || []).length >= 2, true);
check('the upstream output is capped at what was reserved — a caller cannot spend past the ticket',
  /Math\.min\(Number\(upstreamBody\.max_tokens\), cap\)/.test(brokerServer), true);
check('configured, it refuses a stream', streamingRefusal({ stream: true }).includes('cannot be metered'), true);
// Unconfigured must mean "the old gate", never "no gate": with neither metering nor a token list set,
// the passthrough is closed. Asserted by BEHAVIOUR (the function reads env per call), not by text.
delete process.env.BROKER_METERING_SECRET;
check('unconfigured, metering reports itself off', meteringEnabled(), false);
check('…and a stream is no longer refused by the meter (the old path still serves it)', streamingRefusal({ stream: true }), null);
check('the shared token list still applies when metering is off', /BROKER_AI_ALLOWED_TOKENS/.test(brokerServer), true);
// The open-door default: `allowedTokens.length > 0 && !allowedTokens.includes(token)` accepted ANY
// bearer token when the list was empty, on a gateway holding the operator's real upstream key. The
// `.env.example` even documented it as a setting, which is why this is asserted in code AND docs.
check('an EMPTY token list refuses everyone rather than allowing anyone',
  /if \(allowedTokens\.length === 0\) \{[\s\S]{0,220}503/.test(brokerServer), true);
check('a listed token is still required when metering is off', /if \(!allowedTokens\.includes\(token\)\)/.test(brokerServer), true);
check('…and the open-door form is gone', /allowedTokens\.length > 0 && !allowedTokens\.includes\(token\)/.test(brokerServer), false);
check('the env example no longer advertises accepting any bearer token',
  !/leave empty to accept any bearer token/i.test(read('hosted-broker/.env.example')), true);
check('the env example documents the metering variables instead',
  ['BROKER_METERING_INSTANCE_URL', 'BROKER_METERING_SECRET'].every((v) => read('hosted-broker/.env.example').includes(v)), true);
check('with metering ON the shared list is not what authorises the call',
  brokerServer.indexOf('if (!metered) {') < brokerServer.indexOf('BROKER_AI_ALLOWED_TOKENS'), true);
process.env.BROKER_METERING_SECRET = 'test-internal-secret-not-a-real-one';
check('a served call whose charge does not land is logged, not swallowed', /usage report failed for a served call/.test(brokerServer), true);
check('the token counts are read once, in the broker module, and reused',
  [brokerUsageFromResponse({ usage: { prompt_tokens: 3, completion_tokens: 4 } }).outputTokens, usageFromResponse({ usage: { prompt_tokens: 3, completion_tokens: 4 } }).outputTokens].join(','), '4,4');

console.log('\n8. the wiring between the two services agrees');
check('the broker posts to the paths the app mounts', ['verify', 'usage', 'refund'].map((p) => new RegExp(`'${p}'`).test(code(read('hosted-broker/src/metering.js')))).join(','), 'true,true,true');
check('…under the same /api/broker prefix the app uses', /askInstance\('verify'/.test(code(read('hosted-broker/src/metering.js'))) && /\/api\/broker\/\$\{path\}/.test(code(read('hosted-broker/src/metering.js'))), true);
check('the app mounts the router at /api/broker', /app\.use\('\/api\/broker', brokerRoutes\)/.test(code(read('server/src/index.js'))), true);
// Field names cross the process boundary, so a rename on one side is a silent 400 on the other.
// Every field the broker puts in the verify body must be a field the app reads. Checked as a SET, so
// adding a field on one side without the other fails here rather than silently becoming a default.
const verifyFields = (code(read('hosted-broker/src/metering.js')).split("askInstance('verify'")[1] || '').split('}, VERIFY_TIMEOUT_MS)')[0].match(/^\s*([a-zA-Z]+)(?::|,)/gm) || [];
check('the broker sends the fields the app reads (and no others)', verifyFields.map((f) => f.trim().replace(/[:,]$/, '')).sort().join(','), 'maxOutputTokens,model,promptChars,token');
check('…and each one is read by the app', ['token', 'model', 'promptChars', 'maxOutputTokens'].every((f) => new RegExp(`req\\.body\\?\\.${f}`).test(routes)).toString(), 'true');
check('the cap the app returns is the field the broker then reads', /reservation\.maxOutputTokens/.test(brokerServer), true);
check('the usage fields the broker sends are the fields the app reads', ['inputTokens', 'outputTokens', 'durationMs'].every((f) => new RegExp(`req\\.body\\?\\.${f}`).test(routes)).toString(), 'true');
check('promptCharsOf counts string content', promptCharsOf([{ role: 'user', content: 'abcd' }]), 4);
check('…and array content, so a vision request is not reserved against zero', promptCharsOf([{ role: 'user', content: [{ type: 'text', text: 'abcde' }] }]), 5);
check('…and a malformed body is zero, not a crash', promptCharsOf(undefined), 0);

console.log('\n9. the gaps are written down where the code is');
check('revocation is stated as missing', METERING_CAVEATS.some((c) => /cannot be revoked/.test(c)), true);
check('the unreported-reservation exposure is stated', METERING_CAVEATS.some((c) => /never reported keeps its reservation/.test(c)), true);
check('the replay bound is stated honestly', METERING_CAVEATS.some((c) => /in-process nonce set, not by a stored record/.test(c)), true);
check('the broker README no longer describes an unmetered gateway', /metering/i.test(read('hosted-broker/README.md')), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ the paid AI default has a path through it that is not paid\n');
  process.exit(1);
}
console.log('a brokered call reserves its account\'s credits, is charged the product\'s price, and leaves a usage row\n');
