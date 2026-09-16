import { Wrench } from 'lucide-react';
import { C } from './deckConstants';
import { Card } from './DeckUI';

// Workshop Tools (guitar tuner, unit converters, electronics calculators) —
// a later phase of the Command Deck Phase 2 build. Placeholder so the tab
// has somewhere real to land in the meantime.
export default function DeckTools() {
  return (
    <Card title="Workshop tools" sub="Tuner, unit converters, and electronics calculators.">
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.6rem', padding: '1.5rem 0', color: C.walnutSoft }}>
        <Wrench size={28} />
        <p style={{ margin: 0, fontSize: '0.85rem', textAlign: 'center' }}>Coming soon — the guitar tuner and calculators are next.</p>
      </div>
    </Card>
  );
}
