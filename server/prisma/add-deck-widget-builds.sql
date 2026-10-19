-- DeckWidgetBuild — progress for a Jarvis-triggered Command Deck widget
-- build (server/src/functions/buildDeckWidget.js), polled by the Settings
-- widget manager as a progress bar rather than shown in chat. Run on prod
-- Supabase via the SQL editor ("Run without RLS", as with every other
-- Morpheus table — Prisma direct connection, not PostgREST).

CREATE TABLE IF NOT EXISTS deck_widget_builds (
  id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  created_by_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  description   text NOT NULL,
  widget_key    text,
  status        text NOT NULL DEFAULT 'planning',
  step_index    integer NOT NULL DEFAULT 0,
  step_count    integer NOT NULL DEFAULT 0,
  step_title    text,
  message       text,
  created_date  timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_date  timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS deck_widget_builds_created_by_id_idx ON deck_widget_builds (created_by_id);
