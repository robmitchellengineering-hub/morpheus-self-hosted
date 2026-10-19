import { useState } from 'react';
import { useCommandDeck } from '@/contexts/CommandDeckContext';
import { C } from '../deckConstants';
import { Card } from '../DeckUI';

const QUOTES = [
  { text: 'Success is not final, failure is not fatal: it is the courage to continue that counts.', author: 'Winston Churchill' },
  { text: 'The only way to do great work is to love what you do.', author: 'Steve Jobs' },
  { text: 'Your time is limited, don\'t waste it living someone else\'s life.', author: 'Steve Jobs' },
  { text: 'It does not matter how slowly you go as long as you do not stop.', author: 'Confucius' },
  { text: 'Believe you can and you\'re halfway there.', author: 'Theodore Roosevelt' },
  { text: 'The future belongs to those who believe in the beauty of their dreams.', author: 'Eleanor Roosevelt' },
  { text: 'Do what you can, with what you have, where you are.', author: 'Theodore Roosevelt' },
  { text: 'Happiness is not something ready made. It comes from your own actions.', author: 'Dalai Lama' },
  { text: 'The best time to plant a tree was 20 years ago. The second best time is now.', author: 'Chinese Proverb' },
  { text: 'Success is walking from failure to failure with no loss of enthusiasm.', author: 'Winston Churchill' }
];

export default function RandomInspirationalQuoteWidget() {
  useCommandDeck();
  const [quote] = useState(() => QUOTES[Math.floor(Math.random() * QUOTES.length)]);

  return (
    <Card title="Random quote" sub="A little wisdom on refresh.">
      <div style={{ padding: '1rem 0' }}>
        <p style={{ fontSize: '0.95rem', fontStyle: 'italic', margin: 0, lineHeight: 1.5, color: C.ink }}>“{quote.text}”</p>
        <p style={{ fontSize: '0.85rem', margin: '0.5rem 0 0', color: C.walnutSoft }}>— {quote.author}</p>
      </div>
    </Card>
  );
}
