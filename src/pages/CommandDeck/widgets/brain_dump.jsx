import { useState } from 'react';
import { Plus, X, ListChecks, Compass, Lightbulb } from 'lucide-react';
import { useCommandDeck } from '@/contexts/CommandDeckContext';
import { C } from '../deckConstants';
import { Card, MicField, IconButton, EmptyNote, inputStyle, rowBox, ghostBtn, pillBtn } from '../DeckUI';

export default function BrainDumpWidget() {
  const { dump, dumpInput, setDumpInput, dumpPending, quickFileMsg, detectOwner, addDump, removeDump, promoteDump, askToDelete } = useCommandDeck();
  const [dumpSearch, setDumpSearch] = useState('');
  const matches = (text, term) => !term.trim() || (text || '').toLowerCase().includes(term.trim().toLowerCase());
  const visibleDump = dump.filter((d) => matches(d.text, dumpSearch));

  return (
    <Card
      title="Brain dump"
      sub="Whatever's rattling around — get it out. One thought or five, Jarvis splits it up and files each piece where it belongs; name someone and their piece goes to them."
      search={dump.length > 0 ? { value: dumpSearch, onChange: setDumpSearch, placeholder: 'Search unsorted dump…' } : undefined}
    >
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <MicField value={dumpInput} onChange={setDumpInput} onSubmit={addDump} placeholder="Type it. Don't think." style={inputStyle} disabled={dumpPending} />
        {/* Disabled while a classification is in flight. The real guard is in addDump (a
            ref, not this state), because state is not visible to a second press in the same
            tick — but a live-looking button that silently does nothing is its own bug. */}
        <IconButton onClick={addDump} color={C.oxblood} disabled={dumpPending}><Plus size={18} color={C.paper} /></IconButton>
      </div>
      {/* Filing takes a classifier round trip. Without this the panel just sat there and
          you could not tell whether the press had registered — which is what invited the
          second press that used to file the same text twice. */}
      {dumpPending && (
        <p style={{ fontSize: '0.7rem', fontWeight: 600, color: C.walnutSoft, marginTop: '0.4rem', marginBottom: 0 }}>
          Filing it — splitting the thoughts up and putting each where it belongs…
        </p>
      )}
      {dumpInput.trim() && detectOwner(dumpInput) && (
        <p style={{ fontSize: '0.7rem', fontWeight: 600, color: detectOwner(dumpInput)?.color, marginTop: '0.4rem', marginBottom: 0 }}>
          → anything for {detectOwner(dumpInput)?.name} goes to their list
        </p>
      )}
      {quickFileMsg && (
        <p style={{ fontSize: '0.75rem', fontWeight: 600, color: C.sage, marginTop: '0.5rem', marginBottom: 0 }}>✓ {quickFileMsg}</p>
      )}
      {dump.length > 0 && (
        <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
          {visibleDump.length === 0 && <EmptyNote text="No matches." />}
          {visibleDump.map((item) => (
            <div key={item.id} style={{ ...rowBox, flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ flex: '1 1 100%', fontSize: '0.88rem', marginBottom: '0.3rem' }}>{item.text}</span>
              <button onClick={() => promoteDump(item, 'task')} style={{ ...pillBtn(C.sage), display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                <ListChecks size={12} /> Task
              </button>
              <button onClick={() => promoteDump(item, 'strategy')} style={{ ...pillBtn(C.brass), display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                <Compass size={12} /> Strategy
              </button>
              <button onClick={() => promoteDump(item, 'knowledge')} style={{ ...pillBtn(C.walnutSoft), display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                <Lightbulb size={12} /> Idea
              </button>
              <button onClick={() => askToDelete(() => removeDump(item.id))} style={ghostBtn}><X size={14} color={C.walnutSoft} /></button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
