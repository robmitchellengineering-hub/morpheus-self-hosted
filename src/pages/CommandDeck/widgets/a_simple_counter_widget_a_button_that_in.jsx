import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useCommandDeck } from '@/contexts/CommandDeckContext';
import { Card, pillBtn } from '../DeckUI';
import { C } from '../deckConstants';

export default function SimpleCounterWidget() {
  useCommandDeck();
  const [count, setCount] = useState(0);
  return (
    <Card title="Counter" sub="A simple count. No pulse yet.">
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '2rem 0', flexDirection: 'column', gap: '0.75rem' }}>
        <span style={{ fontSize: '3rem', fontWeight: 700, color: C.walnut }}>{count}</span>
        <button onClick={() => setCount((c) => c + 1)} style={{ ...pillBtn(C.brass), display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
          <Plus size={16} /> Increment
        </button>
      </div>
    </Card>
  );
}
