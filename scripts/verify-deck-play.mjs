// Runtime verification for the Asteroids reward's pure logic — the play bank and the board.
//
// Dependency-free, so it runs in CI's no-install guards job. Run:
//   node scripts/verify-deck-play.mjs
//
// The bank is a ledger (credited seconds minus played seconds) with a unique index on
// (created_by_id, task_id) behind it, and the board is Morpheus-wide — every account sees it. Those two
// facts are why this file exists: an arithmetic slip here hands out free play time, and the board is
// the one place in the Deck where a user-supplied string goes in front of other people.
import { readFileSync } from 'node:fs';
import {
  SECONDS_PER_TASK, INITIALS_LENGTH,
  creditedSeconds, playedSeconds, bankSeconds,
  normalizeInitials, bestPerPlayer, leaderboard, formatClock,
} from '../src/pages/CommandDeck/game/playBank.js';

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

console.log('\n1. the bank is a ledger: earned minus played');
check('a task is a minute', SECONDS_PER_TASK, 60);
check('nothing yet', bankSeconds([], []), 0);
check('one task, not played', bankSeconds([{ seconds: 60 }], []), 60);
check('three tasks', bankSeconds([{ seconds: 60 }, { seconds: 60 }, { seconds: 60 }], []), 180);
check('…and a game spends what it played', bankSeconds([{ seconds: 60 }, { seconds: 60 }], [{ seconds_played: 45 }]), 75);
check('the whole bank can be spent', bankSeconds([{ seconds: 60 }], [{ seconds_played: 60 }]), 0);
check('credited/played are summed separately', [creditedSeconds([{ seconds: 60 }]), playedSeconds([{ seconds_played: 20 }])], [60, 20]);
// A balance below zero means something upstream is wrong; showing "-2 minutes" would be worse than
// showing none, so it clamps rather than going negative.
check('the balance never goes negative', bankSeconds([{ seconds: 60 }], [{ seconds_played: 600 }]), 0);
check('junk is not credited', bankSeconds([{ seconds: 'lots' }, { seconds: -60 }, { seconds: null }, {}], []), 0);
check('junk is not played either', bankSeconds([{ seconds: 60 }], [{ seconds_played: NaN }, { seconds_played: -5 }, {}]), 60);
check('non-arrays do not throw', bankSeconds(null, undefined), 0);

console.log('\n2. initials are exactly three arcade characters, or refused');
check('the length is 3', INITIALS_LENGTH, 3);
check('lowercase is uppercased', normalizeInitials('rob'), 'ROB');
check('digits are allowed', normalizeInitials('r0b'), 'R0B');
check('punctuation is dropped, not counted', normalizeInitials('r.0-b'), 'R0B');
check('…and a result that is too short is refused outright', normalizeInitials('R.B'), '');
check('too short is refused', normalizeInitials('RO'), '');
check('too long is refused rather than trimmed', normalizeInitials('ROBB'), '');
check('empty is refused', normalizeInitials('   '), '');
check('null is refused', normalizeInitials(null), '');
// Refused, not silently padded — the player has to see that it did not take, rather than later
// finding "RO-" on a board everyone can read.
check('nothing is ever padded to length', normalizeInitials('R'), '');

console.log('\n3. the board is one row per player, their best');
const alice1 = { created_by_id: 'a', initials: 'AAA', score: 100, created_date: '2026-10-01T00:00:00Z' };
const alice2 = { created_by_id: 'a', initials: 'AAA', score: 250, created_date: '2026-10-02T00:00:00Z' };
const bob1 = { created_by_id: 'b', initials: 'BBB', score: 150, created_date: '2026-10-01T12:00:00Z' };
check('a player appears once, with their best', bestPerPlayer([alice1, bob1, alice2]).map((r) => [r.initials, r.score]), [['AAA', 250], ['BBB', 150]]);
check('sorted by score, best first', bestPerPlayer([bob1, alice1]).map((r) => r.initials), ['BBB', 'AAA']);
// Ties break on who got there first, so matching a score cannot push you above the person who set it.
const tieEarly = { created_by_id: 'c', initials: 'CCC', score: 150, created_date: '2026-10-01T00:00:00Z' };
check('a tie keeps the earlier score above', bestPerPlayer([bob1, tieEarly]).map((r) => r.initials), ['CCC', 'BBB']);
check('a renamed player is shown under the initials of the best run',
  bestPerPlayer([{ ...alice1, initials: 'OLD' }, alice2]).map((r) => r.initials), ['AAA']);
check('a row with no owner is ignored', bestPerPlayer([{ initials: 'XXX', score: 999 }, alice1]).length, 1);
check('a broken score counts as zero, not as NaN', bestPerPlayer([{ created_by_id: 'z', initials: 'ZZZ', score: 'x' }])[0].score, 0);

console.log('\n4. the leaderboard trims, ranks and marks the viewer');
const scores = [alice2, bob1, tieEarly];
check('limits to the top N', leaderboard(scores, { limit: 2 }).map((r) => r.initials), ['AAA', 'CCC']);
check('ranks from 1', leaderboard(scores, { limit: 2 }).map((r) => r.rank), [1, 2]);
check('marks the viewer\'s own row', leaderboard(scores, { meId: 'b' }).filter((r) => r.isMe).map((r) => r.initials), ['BBB']);
check('…and nobody else\'s', leaderboard(scores, { meId: 'b' }).filter((r) => r.isMe).length, 1);
check('with no viewer, nothing is marked', leaderboard(scores).some((r) => r.isMe), false);
check('a limit of zero is empty, not everything', leaderboard(scores, { limit: 0 }), []);

console.log('\n5. the clock is floored, never rounded up');
check('zero', formatClock(0), '0:00');
check('seconds pad', formatClock(59), '0:59');
check('a whole minute', formatClock(60), '1:00');
check('over three minutes', formatClock(185), '3:05');
check('fractional seconds do not round up', formatClock(59.9), '0:59');
check('junk is zero, not NaN', formatClock(null), '0:00');

console.log('\n6. the wiring that makes it real is present');
const schema = readFileSync(new URL('../server/prisma/schema.prisma', import.meta.url), 'utf8');
const ctx = readFileSync(new URL('../src/contexts/CommandDeckContext.jsx', import.meta.url), 'utf8');
// The unique index is the thing that stops a task paying more than once — un-ticking and re-ticking a
// task to farm play time is exactly the abuse this prevents, so it is asserted rather than assumed.
check('a task can only pay once, ever', /@@unique\(\[created_by_id, task_id\]\)/.test(schema), true);
check('the bank is stored, not derived from the task list', /model DeckPlayCredit \{/.test(schema) && /model DeckPlayScore \{/.test(schema), true);
check('the context credits a completion', /DeckPlayCredit/.test(ctx), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILED\n`);
  process.exit(1);
}
console.log('all good\n');
