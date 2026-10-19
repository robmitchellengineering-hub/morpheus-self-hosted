-- Asteroids reward — the play bank and the Morpheus-wide scoreboard.
--
-- Rob: "when you tick off a task i want a pop up window with retro asteroids ... when you
-- complete a task you can play asteroids for 1 min or choose to bank the time to play more
-- later". Ported from the old base44 deck's Play page, which stored its bank in a Morpheus
-- settings blob; the Deck's own-data rule says the Deck gets its own table instead.
--
-- Additive and idempotent — safe to re-run. Applied with:
--   cd server && node scripts/prod-sql.mjs prisma/add-deck-play.sql --dry-run
--   cd server && node scripts/prod-sql.mjs prisma/add-deck-play.sql

-- One row per completed task. The bank balance is (sum of seconds here) minus (sum of
-- seconds_played on deck_play_scores), so nothing is lost and the balance is auditable.
CREATE TABLE IF NOT EXISTS deck_play_credits (
  id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  created_by_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id       text,
  seconds       integer NOT NULL DEFAULT 60,
  reason        text NOT NULL DEFAULT 'task',
  created_date  timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- A task pays once, ever: un-ticking and re-ticking it cannot farm play time.
CREATE UNIQUE INDEX IF NOT EXISTS deck_play_credits_created_by_id_task_id_key ON deck_play_credits (created_by_id, task_id);

-- Every game played, in full. The board is the best score per account; nothing is windowed.
CREATE TABLE IF NOT EXISTS deck_play_scores (
  id              text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  created_by_id   text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  initials        text NOT NULL,
  score           integer NOT NULL,
  seconds_played  integer NOT NULL,
  created_date    timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS deck_play_scores_score_idx ON deck_play_scores (score);
