import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { useCommandDeck } from '@/contexts/CommandDeckContext';
import { C, LIFE_STREAMS_META } from '../deckConstants';
import { Card, EmptyNote, miniInput, ghostBtn } from '../DeckUI';

function LifeStreamRow({ meta, data, onToggleStatus, onAddNote, onRemoveNote }) {
  const [val, setVal] = useState('');
  const Icon = meta.icon;
  const isOn = data.status === 'on';
  const statusColor = isOn ? C.sage : C.alert;

  const submit = () => {
    if (!val.trim()) return;
    onAddNote(val);
    setVal('');
  };

  return (
    <div style={{ background: C.paper, border: `1px solid ${C.line}`, borderLeft: `4px solid ${statusColor}`, borderRadius: 10, padding: '0.65rem 0.75rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', marginBottom: '0.5rem' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', fontWeight: 600, fontSize: '0.87rem' }}>
          <Icon size={15} color={C.brass} /> {meta.label}
        </span>
        <button
          onClick={onToggleStatus}
          style={{ fontSize: '0.62rem', fontWeight: 600, letterSpacing: '0.04em', padding: '0.25rem 0.55rem', borderRadius: 999, border: 'none', background: statusColor, color: C.paper, cursor: 'pointer', flexShrink: 0 }}
        >
          {isOn ? 'ON' : 'NEEDS WORK'}
        </button>
      </div>

      <div style={{ display: 'flex', gap: '0.4rem', marginBottom: data.notes.length > 0 ? '0.5rem' : 0 }}>
        <input value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} placeholder="Log a note…" style={{ ...miniInput, flex: 1 }} />
        <button onClick={submit} style={{ ...ghostBtn, background: C.tweedDark, borderRadius: 8, padding: '0.4rem' }}><Plus size={14} color={C.walnutSoft} /></button>
      </div>

      {data.notes.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
          {data.notes.map((n) => (
            <div key={n.id} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.78rem' }}>
              <span style={{ flex: 1, color: C.walnutSoft }}>{n.text}</span>
              <button onClick={() => onRemoveNote(n.id)} style={ghostBtn}><X size={12} color={C.walnutSoft} /></button>
            </div>
          ))}
        </div>
      ) : (
        <EmptyNote text="Nothing logged yet." />
      )}
    </div>
  );
}

export default function LifeStreamsWidget() {
  const { lifeStreams, toggleLifeStatus, addLifeNote, removeLifeNote, askToDelete } = useCommandDeck();
  return (
    <Card title="Life streams" sub="The rest of your life, tracked alongside everything else. Tap a status to flag it.">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
        {LIFE_STREAMS_META.map((s) => (
          <LifeStreamRow
            key={s.id}
            meta={s}
            data={lifeStreams[s.id] || { status: 'on', notes: [] }}
            onToggleStatus={() => toggleLifeStatus(s.id)}
            onAddNote={(text) => addLifeNote(s.id, text)}
            onRemoveNote={(noteId) => askToDelete(() => removeLifeNote(s.id, noteId))}
          />
        ))}
      </div>
    </Card>
  );
}
