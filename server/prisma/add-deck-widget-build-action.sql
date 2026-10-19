-- DeckWidgetBuild.action — distinguishes a build job from a delete job
-- (server/src/functions/deleteDeckWidget.js) so Settings' existing
-- progress-bar polling can show "Deleting…" for one without a separate
-- table. Additive, defaults every existing row to 'build' (its only
-- meaning until now). Run on prod Supabase via the SQL editor ("Run
-- without RLS", as with every other Morpheus table).

ALTER TABLE deck_widget_builds ADD COLUMN IF NOT EXISTS action text NOT NULL DEFAULT 'build';
