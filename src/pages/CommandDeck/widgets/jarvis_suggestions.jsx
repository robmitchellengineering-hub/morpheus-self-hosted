import { Loader2, Sparkles } from 'lucide-react';
import { useCommandDeck } from '@/contexts/CommandDeckContext';
import { C } from '../deckConstants';
import { Card, pillBtn, EmptyNote } from '../DeckUI';

export default function JarvisSuggestionsWidget() {
  const { synthesisBusy, synthesisErr, runJarvisSynthesis, lastSynthesis } = useCommandDeck();
  return (
    <Card title="Jarvis's suggestions" sub="Everything you've got, brought together — press for what you're missing.">
      <button
        onClick={runJarvisSynthesis}
        disabled={synthesisBusy}
        style={{ ...pillBtn(C.walnut), width: '100%', padding: '0.65rem', fontSize: '0.85rem', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem', opacity: synthesisBusy ? 0.7 : 1 }}
      >
        {synthesisBusy ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
        {synthesisBusy ? 'Connecting the dots…' : lastSynthesis ? 'Get new suggestions' : 'Get suggestions'}
      </button>
      {synthesisErr && <p style={{ margin: '0.6rem 0 0', fontSize: '0.78rem', color: C.alert }}>Couldn't reach Jarvis that time — give it another go.</p>}
      {lastSynthesis ? (
        <div style={{ marginTop: '0.75rem' }}>
          <p style={{ margin: '0 0 0.4rem', fontSize: '0.68rem', color: C.walnutSoft, letterSpacing: '0.04em' }}>
            {lastSynthesis.created_date ? new Date(lastSynthesis.created_date).toLocaleString() : 'just now'}
          </p>
          <p style={{ margin: 0, fontSize: '0.85rem', lineHeight: 1.6, color: C.ink, whiteSpace: 'pre-wrap' }}>{lastSynthesis.content}</p>
        </div>
      ) : !synthesisBusy && (
        <EmptyNote text="He'll pull together everything on your Deck — tasks, notes, the energy log, the lot — and tell you what's worth acting on." />
      )}
    </Card>
  );
}
