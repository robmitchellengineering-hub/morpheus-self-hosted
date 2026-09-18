import { useCommandDeck } from '@/contexts/CommandDeckContext';
import { C } from '../deckConstants';
import { Card } from '../DeckUI';

export default function TodayDateWidget() {
  useCommandDeck();
  const today = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  return (
    <Card title="Today's date" sub="A big, friendly date.">
      <p style={{ fontSize: '2rem', fontWeight: 600, color: C.ink, margin: 0 }}>{today}</p>
    </Card>
  );
}
