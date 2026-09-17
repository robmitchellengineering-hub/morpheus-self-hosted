import { useState } from 'react';
import { Compass } from 'lucide-react';
import { useCommandDeck } from '@/contexts/CommandDeckContext';
import { Card, StreamList } from '../DeckUI';
import { C } from '../deckConstants';

export default function StrategyWidget() {
  const { strategy, addStrategy, removeStrategy, askToDelete } = useCommandDeck();
  const [strategySearch, setStrategySearch] = useState('');
  const matches = (text, term) => !term.trim() || (text || '').toLowerCase().includes(term.trim().toLowerCase());
  const visibleStrategy = strategy.filter((s) => matches(s.text, strategySearch));

  return (
    <Card
      title="Strategy"
      sub="The long game — where you're steering this, not just running it."
      search={strategy.length > 0 ? { value: strategySearch, onChange: setStrategySearch, placeholder: 'Search strategy notes…' } : undefined}
    >
      <StreamList items={visibleStrategy} onAdd={addStrategy} onRemove={(id) => askToDelete(() => removeStrategy(id))} placeholder="Add a strategic idea…" accent={C.brass} icon={Compass} empty={strategySearch ? 'No matches.' : 'Nothing filed yet — send items here from the brain dump.'} />
    </Card>
  );
}
