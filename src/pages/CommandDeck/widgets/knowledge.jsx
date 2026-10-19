import { useState } from 'react';
import { Lightbulb } from 'lucide-react';
import { useCommandDeck } from '@/contexts/CommandDeckContext';
import { Card, StreamList } from '../DeckUI';
import { C } from '../deckConstants';

export default function KnowledgeWidget() {
  const { knowledge, addKnowledge, removeKnowledge, askToDelete, addPending } = useCommandDeck();
  const [knowledgeSearch, setKnowledgeSearch] = useState('');
  const matches = (text, term) => !term.trim() || (text || '').toLowerCase().includes(term.trim().toLowerCase());
  const visibleKnowledge = knowledge.filter((k) => matches(k.text, knowledgeSearch));

  return (
    <Card
      title="Knowledge & ideas"
      sub="Research, recipes, rabbit holes — whatever might be useful one day."
      search={knowledge.length > 0 ? { value: knowledgeSearch, onChange: setKnowledgeSearch, placeholder: 'Search knowledge & ideas…' } : undefined}
    >
      <StreamList items={visibleKnowledge} onAdd={addKnowledge} adding={!!addPending.knowledge} pendingText="Saving the note…" onRemove={(id) => askToDelete(() => removeKnowledge(id))} placeholder="Add an idea, link, or thought…" accent={C.walnutSoft} icon={Lightbulb} empty={knowledgeSearch ? 'No matches.' : 'Nothing filed yet — send items here from the brain dump.'} />
    </Card>
  );
}
