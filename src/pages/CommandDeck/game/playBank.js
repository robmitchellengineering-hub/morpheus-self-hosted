// Pure logic for the Asteroids reward — the play bank and the Morpheus-wide board.
//
// Dependency-free and import-free on purpose, so scripts/verify-deck-play.mjs can assert all of it in
// CI's no-install guards job, the same way dumpFiling.js is verified. Nothing here touches React,
// the network or the clock, so every rule below is testable without a browser.
//
// THE ECONOMY, in Rob's words (2026-10-02): "when you complete a task you can play asteroids for 1 min
// or choose to bank the time to play more later". So ticking a task earns a minute, playing spends
// what you have banked, and the balance is a LEDGER rather than a counter — see schema.prisma's
// DeckPlayCredit, which also carries the unique index that stops a task paying twice.

export const SECONDS_PER_TASK = 60;
export const INITIALS_LENGTH = 3;

const count = (n) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/** Seconds earned: one row per completed task, so this is the sum of the credits. */
export function creditedSeconds(credits) {
  return (Array.isArray(credits) ? credits : []).reduce((sum, c) => sum + count(c?.seconds), 0);
}

/** Seconds spent: the `seconds_played` on each recorded game. */
export function playedSeconds(scores) {
  return (Array.isArray(scores) ? scores : []).reduce((sum, s) => sum + count(s?.seconds_played), 0);
}

/**
 * What is left to play.
 *
 * Clamped at zero rather than allowed to go negative: a negative balance would be a bug somewhere
 * else, and showing someone "-2 minutes" is worse than showing them none.
 */
export function bankSeconds(credits, scores) {
  return Math.max(0, creditedSeconds(credits) - playedSeconds(scores));
}

/**
 * Three arcade characters, or '' if the input cannot be one.
 *
 * Uppercase A–Z and 0–9 only, because this is what will be shown next to a score on a board every
 * account can see — so it is the one place in the Deck where a user-supplied string goes in front of
 * other people. Anything that is not exactly three valid characters is refused outright rather than
 * silently trimmed or padded, so the player sees that their entry was rejected instead of later
 * finding "RO" or "ROB2" on the board.
 */
export function normalizeInitials(raw) {
  const s = String(raw == null ? '' : raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length === INITIALS_LENGTH ? s : '';
}

/**
 * The board: one row per player, their best score.
 *
 * Ties break on who got there FIRST, which is what makes a board worth climbing — matching an existing
 * score must not push you above the person who set it. `created_date` is compared as a string when it
 * is one (the column comes back as a Date, but the pure function should not care) and falls back to
 * keeping the earlier-seen row, so this is deterministic either way.
 */
export function bestPerPlayer(scores) {
  const best = new Map();
  for (const s of Array.isArray(scores) ? scores : []) {
    const id = s?.created_by_id;
    if (!id) continue;
    const score = Number.isFinite(s?.score) ? Math.floor(s.score) : 0;
    const at = s?.created_date == null ? '' : String(s.created_date);
    const prev = best.get(id);
    if (!prev || score > prev.score) {
      // A new best replaces the previous row outright — including its initials, so a player who
      // renames themselves is shown under the name they had when they set the score on the board.
      best.set(id, { created_by_id: id, initials: normalizeInitials(s?.initials) || '???', score, at });
    }
  }
  return [...best.values()].sort((a, b) => (b.score - a.score) || (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/**
 * The board, trimmed to `limit` rows, with the requesting player's own row marked.
 *
 * `meId` is optional: the board is Morpheus-wide, so most rows will not be the viewer's.
 */
export function leaderboard(scores, { limit = 10, meId = null } = {}) {
  return bestPerPlayer(scores)
    .slice(0, Math.max(0, limit))
    .map((row, i) => ({ ...row, rank: i + 1, isMe: meId != null && row.created_by_id === meId }));
}

/** "3:07" — the clock the player watches run down. Seconds are floored, never rounded up. */
export function formatClock(totalSeconds) {
  const s = count(totalSeconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
