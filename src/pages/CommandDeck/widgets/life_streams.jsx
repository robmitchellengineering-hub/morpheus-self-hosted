import { useRef, useState } from 'react';
import { Plus, X, Paperclip, FileText, Loader2 } from 'lucide-react';
import { useCommandDeck } from '@/contexts/CommandDeckContext';
import { C, LIFE_STREAMS_META } from '../deckConstants';
import { describeUpload } from '../lifeFiles';
import { Card, EmptyNote, miniInput, ghostBtn } from '../DeckUI';

// A photo of a bill, a scan, a lab result — the half of a life stream that was lost when the old
// base44 deck was ported (it had `LifeFile`; this had text notes only). Rob, 2026-10-02: "I cant see
// how you attach a photo to a life strean".
function LifeStreamRow({ meta, data, busy, onToggleStatus, onAddNote, onRemoveNote, onPickFiles, onRemoveFile, onOpenImage }) {
  const [val, setVal] = useState('');
  const fileRef = useRef(null);
  const Icon = meta.icon;
  const isOn = data.status === 'on';
  const statusColor = isOn ? C.sage : C.alert;
  const files = data.files || [];

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

      <div style={{ display: 'flex', gap: '0.4rem', marginBottom: (data.notes.length > 0 || files.length > 0) ? '0.5rem' : 0 }}>
        <input value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} placeholder="Log a note…" style={{ ...miniInput, flex: 1 }} />
        {/* Attach. The input is the real control and stays hidden; the paperclip is the affordance, so
            a phone gets the camera/photo picker from the same tap. */}
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="image/*,application/pdf,.doc,.docx,.txt,.csv"
          onChange={(e) => { const picked = Array.from(e.target.files || []); e.target.value = ''; if (picked.length) onPickFiles(picked); }}
          style={{ display: 'none' }}
        />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          title="Attach a photo or document"
          aria-label={`Attach a photo or document to ${meta.label}`}
          style={{ ...ghostBtn, background: C.tweedDark, borderRadius: 8, padding: '0.4rem', opacity: busy ? 0.6 : 1 }}
        >
          {busy ? <Loader2 size={14} className="animate-spin" color={C.walnutSoft} /> : <Paperclip size={14} color={C.walnutSoft} />}
        </button>
        <button onClick={submit} style={{ ...ghostBtn, background: C.tweedDark, borderRadius: 8, padding: '0.4rem' }}><Plus size={14} color={C.walnutSoft} /></button>
      </div>

      {files.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginBottom: data.notes.length > 0 ? '0.5rem' : 0 }}>
          {files.map((f) => (
            <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', background: C.tweed, border: `1px solid ${C.line}`, borderRadius: 8, padding: '0.2rem 0.3rem', maxWidth: '100%' }}>
              {f.is_image ? (
                <button onClick={() => onOpenImage(f.file_url)} style={{ ...ghostBtn, padding: 0 }} title="Open">
                  <img src={f.file_url} alt={f.file_name || 'attachment'} style={{ width: 26, height: 26, borderRadius: 5, objectFit: 'cover', display: 'block' }} />
                </button>
              ) : (
                <a href={f.file_url} target="_blank" rel="noreferrer" style={{ display: 'flex', color: C.walnutSoft }} title="Open">
                  <FileText size={16} />
                </a>
              )}
              <span style={{ fontSize: '0.68rem', color: C.walnutSoft, maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.file_name || 'attachment'}</span>
              <button onClick={() => onRemoveFile(f.id)} style={{ ...ghostBtn, padding: 0 }} aria-label="Remove attachment"><X size={12} color={C.walnutSoft} /></button>
            </div>
          ))}
        </div>
      )}

      {data.notes.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
          {data.notes.map((n) => (
            <div key={n.id} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.78rem' }}>
              <span style={{ flex: 1, color: C.walnutSoft }}>{n.text}</span>
              <button onClick={() => onRemoveNote(n.id)} style={ghostBtn}><X size={12} color={C.walnutSoft} /></button>
            </div>
          ))}
        </div>
      )}

      {data.notes.length === 0 && files.length === 0 && <EmptyNote text="Nothing logged yet." />}
    </div>
  );
}

export default function LifeStreamsWidget() {
  const { lifeStreams, toggleLifeStatus, addLifeNote, removeLifeNote, addLifeFiles, removeLifeFile, uploadFile, askToDelete, setLightboxImg } = useCommandDeck();
  const [busyKey, setBusyKey] = useState(null);

  // Uploads happen here rather than in the row, so the row stays presentational and a failure to
  // upload is reported by the one place that already knows how (flagSaveErr inside addLifeFiles).
  const pickFiles = async (streamKey, files) => {
    setBusyKey(streamKey);
    try {
      const uploaded = [];
      for (const f of files) {
        try {
          const url = await uploadFile(f);
          uploaded.push(describeUpload(f, url));
        } catch { /* one bad file must not lose the others */ }
      }
      if (uploaded.length) await addLifeFiles(streamKey, uploaded);
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <Card title="Life streams" sub="The rest of your life, tracked alongside everything else. Tap a status to flag it.">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
        {LIFE_STREAMS_META.map((s) => (
          <LifeStreamRow
            key={s.id}
            meta={s}
            data={lifeStreams[s.id] || { status: 'on', notes: [], files: [] }}
            busy={busyKey === s.id}
            onToggleStatus={() => toggleLifeStatus(s.id)}
            onAddNote={(text) => addLifeNote(s.id, text)}
            onRemoveNote={(noteId) => askToDelete(() => removeLifeNote(s.id, noteId))}
            onPickFiles={(files) => pickFiles(s.id, files)}
            onRemoveFile={(fileId) => askToDelete(() => removeLifeFile(s.id, fileId))}
            onOpenImage={(url) => setLightboxImg(url)}
          />
        ))}
      </div>
    </Card>
  );
}
