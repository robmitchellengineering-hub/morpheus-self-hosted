-- Command Deck configurable widgets + business profile. See schema.prisma's
-- comments above DeckWidgetInstance/DeckBusinessProfile for the full
-- reasoning (Rob, 2026-09-17: "I should be able to add custom widgets
-- there too, I just don't want to lose the tools I already have").
-- Run on prod Supabase via the SQL editor ("Run without RLS", as with every
-- other Morpheus table — Prisma direct connection, not PostgREST).

CREATE TABLE IF NOT EXISTS deck_widget_instances (
  id             text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  created_by_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  widget_key     text NOT NULL,
  enabled        boolean NOT NULL DEFAULT true,
  sort_order     integer NOT NULL DEFAULT 0,
  created_date   timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_date   timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (created_by_id, widget_key)
);

CREATE TABLE IF NOT EXISTS deck_business_profiles (
  id                text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  created_by_id     text NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  shop_name         text,
  tagline           text,
  contact_email     text,
  business_context  text,
  created_date      timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_date      timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Backfill: Rob's own account gets every widget explicitly enabled,
-- including signal_chain and week_rhythm (both defaultEnabled: false for
-- any NEW account, since both hardcode his own content) so his live Deck
-- comes out of this migration looking and behaving exactly as it does
-- today. Order matches DeckHome.jsx's existing top-to-bottom layout.
INSERT INTO deck_widget_instances (created_by_id, widget_key, enabled, sort_order)
SELECT id, w.widget_key, true, w.sort_order
FROM users,
  (VALUES
    ('brain_dump', 0), ('today_charge', 1), ('today_one_thing', 2), ('inbox', 3),
    ('calendar', 4), ('signal_chain', 5), ('life_streams', 6), ('strategy', 7),
    ('knowledge', 8), ('tasks', 9), ('week_rhythm', 10), ('backup', 11)
  ) AS w(widget_key, sort_order)
WHERE users.email = 'info@valiantmusic.com.au'
ON CONFLICT (created_by_id, widget_key) DO NOTHING;

-- Backfill: Rob's business_context carries exactly what chatWithJarvis.js /
-- classifyDeckDumpItem.js / syncDeckGmailInbox.js / createDeckDocument.js /
-- suggestDeckReply.js used to hardcode inline, so those prompts read
-- identically to before this migration ran.
INSERT INTO deck_business_profiles (created_by_id, shop_name, tagline, contact_email, business_context)
SELECT id, 'Valiant Music', 'Brunswick Heads / Murwillumbah', 'info@valiantmusic.com.au',
  'Valiant Music, a one-person vintage guitar shop in Brunswick Heads/Murwillumbah, aiming for $100k profit on 30 hrs/week. Rob has ADHD, which is why blunt beats gentle: say things plainly, no caveats.'
FROM users
WHERE users.email = 'info@valiantmusic.com.au'
ON CONFLICT (created_by_id) DO NOTHING;
