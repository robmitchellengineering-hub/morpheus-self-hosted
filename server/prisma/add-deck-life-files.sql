-- Life-stream attachments — a photo of a bill, a scan, a document.
--
-- Rob's audit of the old base44 deck (DECK-OLD-VS-NEW.md §2): the old deck had `LifeFile`, and the port
-- kept text notes only, so a stream could hold prose and nothing else. Rob confirmed the gap from the
-- UI side on 2026-10-02: "I cant see how you attach a photo to a life strean".
--
-- Additive and idempotent — safe to re-run. Applied with:
--   cd server && node scripts/prod-sql.mjs prisma/add-deck-life-files.sql --dry-run
--   cd server && node scripts/prod-sql.mjs prisma/add-deck-life-files.sql

CREATE TABLE IF NOT EXISTS deck_life_files (
  id             text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  life_stream_id text NOT NULL REFERENCES deck_life_streams(id) ON DELETE CASCADE,
  created_by_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_url       text NOT NULL,
  file_name      text NOT NULL DEFAULT '',
  file_type      text NOT NULL DEFAULT '',
  is_image       boolean NOT NULL DEFAULT false,
  note           text,
  created_date   timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS deck_life_files_life_stream_id_idx ON deck_life_files (life_stream_id);
