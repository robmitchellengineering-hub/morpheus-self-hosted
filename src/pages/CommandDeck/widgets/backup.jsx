import { useCommandDeck } from '@/contexts/CommandDeckContext';
import { C } from '../deckConstants';
import { Card, pillBtn, miniInput } from '../DeckUI';

export default function BackupWidget() {
  const { backupText, backupBusy, backupMsg, runExport, copyBackup, downloadBackup } = useCommandDeck();
  return (
    <Card title="Backup & export" sub="A real copy of everything on this deck, whenever you want one.">
      <button onClick={runExport} disabled={backupBusy} style={{ ...pillBtn(C.walnutSoft), width: '100%', padding: '0.55rem', fontSize: '0.8rem', opacity: backupBusy ? 0.6 : 1 }}>
        {backupBusy ? 'Working…' : 'Export everything'}
      </button>
      {backupText && (
        <div style={{ marginTop: '0.6rem' }}>
          <textarea readOnly value={backupText} rows={4} style={{ ...miniInput, width: '100%', resize: 'vertical', boxSizing: 'border-box', fontSize: '0.7rem' }} />
          <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.4rem' }}>
            <button onClick={copyBackup} style={{ ...pillBtn(C.sage), flex: 1, padding: '0.5rem' }}>Copy</button>
            <button onClick={downloadBackup} style={{ ...pillBtn(C.brass), flex: 1, padding: '0.5rem' }}>Download</button>
          </div>
        </div>
      )}
      {backupMsg && <p style={{ fontSize: '0.75rem', color: C.walnutSoft, marginTop: '0.6rem', marginBottom: 0 }}>{backupMsg}</p>}
    </Card>
  );
}
