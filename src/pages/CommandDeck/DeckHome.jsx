import { useCommandDeck } from '@/contexts/CommandDeckContext';
import { orderDeckWidgets } from './deckWidgetOrder';

// The "Deck" home tab. Each widget lives in its own file under ./widgets/,
// named exactly `<widget_key>.jsx` — this loader just maps that filename to
// the key and renders whichever ones the account has enabled, in their
// chosen order (see deckWidgets.js for the registry of valid keys). A new
// widget file dropped into ./widgets/ is picked up automatically on the next
// build, with no edit needed here — the property a Jarvis-triggered widget
// build depends on to ship without ever touching this file.
const widgetModules = import.meta.glob('./widgets/*.jsx', { eager: true });
const widgetComponents = Object.fromEntries(
  Object.entries(widgetModules).map(([path, mod]) => [path.replace('./widgets/', '').replace('.jsx', ''), mod.default]),
);

export default function DeckHome() {
  const { widgetInstances } = useCommandDeck();
  // ORDERED ON READ, not trusted from storage: brain dump is pinned to the top for every account, including
  // the ones whose stored `sort_order` already puts something else first (see deckWidgetOrder.js).
  const orderedWidgets = orderDeckWidgets(widgetInstances).filter((w) => w.enabled);

  return (
    <>
      {orderedWidgets.map((w) => {
        const Widget = widgetComponents[w.widget_key];
        return Widget ? <Widget key={w.widget_key} /> : null;
      })}
    </>
  );
}
