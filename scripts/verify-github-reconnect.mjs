// Runtime verification that an expired GitHub credential is never handed out as if it worked, and
// that the operator is told what to do about it.
//
// Dependency-free (source assertions plus the pure classifier), so it runs in CI's no-install job.
// Run:  node scripts/verify-github-reconnect.mjs
//
// WHY THIS EXISTS (2026-09-28). `getGithubConnection` refreshed an expiring GitHub token and, when
// the refresh failed, FELL THROUGH and returned the access token it had just failed to renew —
// defended in a comment: "the caller's own GitHub API call will surface a clear error if it's
// actually dead, same as before this fix." That is word for word the defect fixed for Google the
// same day, in three modules, each with a comment defending it. The user-visible difference is only
// whose words they get: GitHub's own 401, deep inside a COMPILE or a push, naming no cause and no
// action, instead of "reconnect GitHub".
//
// The exception is deliberate and is asserted below: a NETWORK failure falls through, because a blip
// must not lock someone out of work that is fine.
import { readFileSync } from 'node:fs';
import { classifyRefreshFailure, reconnectMessage, GITHUB_REFRESH_REASONS } from '../server/src/lib/githubReconnect.js';

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

console.log('\n1. the classifier tells the three failures apart');
check("GitHub's dead-grant code is classified as revoked",
  classifyRefreshFailure({ error: 'bad_refresh_token', error_description: 'The refresh token is expired.' }), 'revoked');
check('the bare code alone is enough', classifyRefreshFailure({ error: 'invalid_grant' }), 'revoked');
check('a bad client secret is OUR configuration, not the operator\'s connection',
  classifyRefreshFailure({ error: 'incorrect_client_credentials' }), 'not_configured');
// The direction that matters: an error we do not recognise must not tell someone to redo work that
// was never broken. Same rule the Google classifier holds itself to.
check('an unrecognised refusal is treated as transient, and says so',
  classifyRefreshFailure({ error: 'server_error' }), 'network');
check('no data at all does not crash', classifyRefreshFailure(undefined), 'network');
check('the reason vocabulary is exactly the three', GITHUB_REFRESH_REASONS.join(','), 'revoked,not_configured,network');

console.log('\n2. every reason gets its own sentence, naming the way out');
check('revoked tells them to reconnect, and where',
  /reconnect GitHub in Morpheus Settings/.test(reconnectMessage('revoked')), true);
check('not_configured says it is a deployment problem, not theirs',
  /deployment problem, not something you can fix/.test(reconnectMessage('not_configured')), true);
check('network says try again before reconnecting',
  /usually temporary, so try again/.test(reconnectMessage('network')), true);
check('a Google sentence is never used for GitHub',
  GITHUB_REFRESH_REASONS.every((r) => !/Google/i.test(reconnectMessage(r))), true);

console.log('\n3. the refresh is classified, not collapsed to a boolean');
const gh = read('server/src/lib/github.js');
check('a missing refresh path is reported as its own reason',
  /return \{ ok: false, reason: 'not_configured' \}/.test(gh), true);
check('a refused refresh is classified rather than discarded',
  /reason = classifyRefreshFailure\(data\)/.test(gh), true);
check('a transport failure is its own reason',
  /return \{ ok: false, reason: 'network' \}/.test(gh), true);
check('a successful refresh returns the new connection',
  /return \{ ok: true, connection:/.test(gh), true);

console.log('\n4. a dead token is refused, and only a network blip falls through');
check('an unrefreshable expired token throws a named error',
  /code: 'GITHUB_RECONNECT_REQUIRED'/.test(gh), true);
check('…carrying the classified reason', /reason: refreshed\.reason/.test(gh), true);
check('…and the network case is the ONE exception that still tries',
  /if \(refreshed\.reason !== 'network'\)/.test(gh), true);
// The exact line that used to be here, and the comment that defended it.
check('the old "hand back the stale token" fall-through is gone',
  /Fall through and hand back the possibly-stale token/.test(gh), false);
check('the caller-visible error names the surface to reconnect',
  /reconnectMessage\(refreshed\.reason\)/.test(gh), true);

console.log('\n5. this check runs where it is supposed to');
check('it is in verify.mjs\'s HARD list',
  /'verify-github-reconnect\.mjs'/.test(read('scripts/verify.mjs')), true);
check('CI runs it in the guards job (no install)',
  /node scripts\/verify-github-reconnect\.mjs/.test(read('.github/workflows/ci.yml')), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) { console.log(`${failures} FAILED\n`); process.exit(1); }
console.log('a dead GitHub credential is reported, not tried\n');
