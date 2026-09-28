// The real widget registry behind /deck's configurable sections (Rob,
// 2026-09-17: "I should be able to add custom widgets there too, I just
// don't want to lose the tools I already have"). This is the single source
// of truth for which widget keys exist, their default enabled state for a
// brand-new account, and their default display order — DeckHome.jsx builds
// each widget's actual JSX (it needs closures over DeckHome's own shared
// state/handlers, so the JSX itself isn't built here) and filters/orders it
// against this list plus the account's own DeckWidgetInstance rows; the
// Settings widget manager uses this same list for its enable/reorder UI.
//
// `signal_chain` and `week_rhythm` are the two entries that default OFF for
// a new account — both hardcode Rob's own real content (Signal Chain is his
// consignment/repair/Murbah workflow; Week rhythm literally names his real
// employee, "Derek covers the shop") rather than reading from any account's
// own data, so they're kept as the concrete, working examples of "a custom
// widget" rather than something every new account gets by default. Every
// other entry is generic enough — and actually driven by that account's own
// data — to ship to anyone. Rob's own account is explicitly backfilled with
// every widget (including these two) enabled by the migration that
// introduced this table, so nothing on his existing Deck changes.
export const DECK_WIDGETS = [
  // `note` is shown under the label in Deck Settings → Widgets. This one is
  // load-bearing copy, not decoration: switching this widget off is also the
  // per-account opt-out from proactive insight (server/src/lib/
  // deckInsightGate.js), and nobody would guess that from the label alone.
  { key: 'jarvis_suggestions', label: "Jarvis's suggestions", defaultEnabled: true, note: 'Off = no proactive insights — Jarvis stops reading across your Deck unprompted, and no AI credit is spent on it.' },
  { key: 'brain_dump', label: 'Brain dump', defaultEnabled: true },
  { key: 'today_charge', label: "Today's charge", defaultEnabled: true },
  { key: 'today_one_thing', label: "Today's one thing", defaultEnabled: true },
  { key: 'inbox', label: 'Inbox', defaultEnabled: true },
  { key: 'calendar', label: 'Calendar', defaultEnabled: true },
  { key: 'signal_chain', label: 'Signal chain', defaultEnabled: false },
  { key: 'life_streams', label: 'Life streams', defaultEnabled: true },
  { key: 'strategy', label: 'Strategy', defaultEnabled: true },
  { key: 'knowledge', label: 'Knowledge & ideas', defaultEnabled: true },
  { key: 'tasks', label: 'Task board', defaultEnabled: true },
  { key: 'week_rhythm', label: 'Week rhythm', defaultEnabled: false },
  { key: 'backup', label: 'Backup & export', defaultEnabled: true },
  { key: 'a_simple_counter_widget_a_button_that_in', label: 'Counter', defaultEnabled: false },
  { key: 'build_me_a_widget_that_shows_a_random_in', label: 'Random quote', defaultEnabled: false },
  { key: 'can_you_build_me_a_widget_that_displays_', label: 'Energy sparkline', defaultEnabled: false, createdBy: '4c06993a-8979-4612-bf55-3d3c767f8b48' },
];

export const DECK_WIDGET_KEYS = DECK_WIDGETS.map((w) => w.key);
