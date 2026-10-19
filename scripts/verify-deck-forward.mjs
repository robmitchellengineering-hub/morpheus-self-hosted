// Runtime verification for the forward-to-Jarvis capture's matching logic, plus the
// wiring that reaches it.
//
// Dependency-free except for the import-free matcher it tests, so it runs in CI's
// no-install guards job. Run:  node scripts/verify-deck-forward.mjs
//
// The one hard edge this pins (hazard H13 in miniature): a forward must be DETECTED.
// If the To/Delivered-To matcher stops matching <local>+jarvis@ / <local>+build@, every
// forward falls through to the inquiry classifier, which drops most of them — and the
// sync still reports success, so nothing says so. The matcher is pure, so it can be
// proven here with fixtures rather than by waiting for a live forward.
import { readFileSync } from 'node:fs';
import { forwardTagFor, forwardAddresses, FORWARD_TAGS } from '../server/src/lib/deckForward.js';

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

console.log('\n1. the matcher detects a forward to each alias');
check('the two tags are exactly jarvis and build', FORWARD_TAGS, ['jarvis', 'build']);
check('jarvis alias matched', forwardTagFor('info@valiantmusic.com.au', 'info+jarvis@valiantmusic.com.au'), 'jarvis');
check('build alias matched', forwardTagFor('info@valiantmusic.com.au', 'info+build@valiantmusic.com.au'), 'build');
check('a full To header with a display name still matches',
  forwardTagFor('info@valiantmusic.com.au', '"Rob Mitchell" <info+jarvis@valiantmusic.com.au>'), 'jarvis');
check('Delivered-To (the envelope address) is searched too',
  forwardTagFor('info@valiantmusic.com.au', 'someone@example.com', 'info+build@valiantmusic.com.au'), 'build');
check('case does not matter',
  forwardTagFor('Info@ValiantMusic.com.au', 'INFO+JARVIS@VALIANTMUSIC.COM.AU'), 'jarvis');
check('an unrelated recipient is not a forward',
  forwardTagFor('info@valiantmusic.com.au', 'info@valiantmusic.com.au'), null);
check('a plain inbox address is not a forward',
  forwardTagFor('info@valiantmusic.com.au', 'someone@else.com'), null);
check('a different +suffix is not a forward',
  forwardTagFor('info@valiantmusic.com.au', 'info+spam@valiantmusic.com.au'), null);
check('no header value is not a forward', forwardTagFor('info@valiantmusic.com.au'), null);
check('a missing google email cannot match', forwardTagFor('', 'info+jarvis@valiantmusic.com.au'), null);
check('forwardAddresses derives both aliases',
  forwardAddresses('info@valiantmusic.com.au'),
  ['info+jarvis@valiantmusic.com.au', 'info+build@valiantmusic.com.au']);

console.log('\n2. the sync is wired to capture forwards, not just classify inquiries');
const sync = readFileSync(new URL('../server/src/functions/syncDeckGmailInbox.js', import.meta.url), 'utf8');
const syncCode = sync.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
check('the matcher is imported', /import \{ forwardTagFor \} from '\.\.\/lib\/deckForward\.js'/.test(syncCode), true);
check('the matcher is called with the To and Delivered-To headers',
  /forwardTagFor\(email, full\.to, full\.deliveredTo\)/.test(syncCode), true);
check('a forward is filed with its tag', /forward_tag: forwardTag/.test(syncCode), true);
check('the inquiry classifier is still called for non-forwards',
  /classifyIsInquiry\(user\.id, full\)/.test(syncCode), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) { console.log(`${failures} FAILED\n`); process.exit(1); }
console.log('all good\n');
