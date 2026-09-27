import { useState } from 'react';
import { Plus, X, RefreshCw, Reply, Send, Loader2 } from 'lucide-react';
import { useCommandDeck } from '@/contexts/CommandDeckContext';
import { C, CHANNELS, inboxStageLabel } from '../deckConstants';
import { Card, IconButton, EmptyNote, PendingNote, inputStyle, miniInput, rowBox, ghostBtn, pillBtn, chipBtn } from '../DeckUI';

export default function InboxWidget() {
  const {
    inbox, iForm, setIForm, addInbox, cycleInboxStage, removeInbox, askToDelete, addPending,
    gmailSyncing, gmailSyncMsg, syncGmailInbox,
    replyDraftFor, replyDraftText, setReplyDraftText, replyBusy, replyDraftErr, startReplyDraft, cancelReplyDraft, sendReplyDraft,
  } = useCommandDeck();
  const [inboxSearch, setInboxSearch] = useState('');
  const [filter, setFilter] = useState('all');

  const matches = (text, term) => !term.trim() || (text || '').toLowerCase().includes(term.trim().toLowerCase());
  const visibleInbox = inbox.filter((i) => matches(`${i.from_name} ${i.message}`, inboxSearch));

  const stageColor = { new: C.alert, replied: C.gold, done: C.sage };
  const channelLabel = (id) => (CHANNELS.find((c) => c.id === id) || {}).label || id;
  const visible = filter === 'all' ? visibleInbox : visibleInbox.filter((i) => i.channel === filter);
  const openCount = visibleInbox.filter((i) => i.stage !== 'done').length;

  const onAdd = addInbox;
  const adding = !!addPending.inbox;
  const onCycle = cycleInboxStage;
  const onRemove = (id) => askToDelete(() => removeInbox(id));
  const form = iForm;
  const setForm = setIForm;
  const onSyncGmail = syncGmailInbox;
  const onStartReply = startReplyDraft;
  const onCancelReply = cancelReplyDraft;
  const onSendReply = sendReplyDraft;

  return (
    <Card
      title="Inbox"
      sub="Every inquiry, one place — email, the website, whatever comes in. Log it as it comes."
      search={inbox.length > 0 ? { value: inboxSearch, onChange: setInboxSearch, placeholder: 'Search inbox…' } : undefined}
    >
      <div>
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.5rem', opacity: adding ? 0.6 : 1, pointerEvents: adding ? 'none' : 'auto' }}>
          <select value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })} style={{ ...miniInput, flex: '0 1 110px' }}>
            {CHANNELS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
          <input placeholder="From (name)" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} style={{ ...miniInput, flex: '1 1 100px' }} />
        </div>
        <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.7rem', opacity: adding ? 0.6 : 1, pointerEvents: adding ? 'none' : 'auto' }}>
          <input
            placeholder="What did they ask / say?"
            value={form.message}
            onChange={(e) => setForm({ ...form, message: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && onAdd()}
            style={{ ...inputStyle, flex: 1 }}
          />
          <IconButton onClick={onAdd} color={C.alert} disabled={adding}><Plus size={18} color={C.paper} /></IconButton>
        </div>
        <PendingNote show={adding} text="Logging it — it will show up in the list in a moment…" />

        {onSyncGmail && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.65rem' }}>
            <button
              onClick={onSyncGmail}
              disabled={gmailSyncing}
              style={{ ...pillBtn(C.brass), display: 'inline-flex', alignItems: 'center', gap: '0.35rem', opacity: gmailSyncing ? 0.7 : 1 }}
            >
              {gmailSyncing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              {gmailSyncing ? 'Syncing…' : 'Sync Gmail'}
            </button>
            {gmailSyncMsg && <span style={{ fontSize: '0.72rem', color: C.walnutSoft }}>{gmailSyncMsg}</span>}
          </div>
        )}

        {visibleInbox.length > 0 && (
          <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', marginBottom: '0.65rem' }}>
            <button onClick={() => setFilter('all')} style={chipBtn(filter === 'all', C.walnutSoft)}>All ({openCount} open)</button>
            {CHANNELS.filter((c) => visibleInbox.some((i) => i.channel === c.id)).map((c) => (
              <button key={c.id} onClick={() => setFilter(c.id)} style={chipBtn(filter === c.id, C.walnutSoft)}>{c.label}</button>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
          {visible.map((i) => {
            const canReply = i.channel === 'gmail' && !!i.from_email && !!onStartReply;
            const drafting = replyDraftFor === i.id;
            return (
              <div key={i.id} style={{ ...rowBox, flexDirection: 'column', alignItems: 'stretch', gap: '0.4rem' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', flexWrap: 'wrap' }}>
                  {/* minWidth: 0 overrides the flex item's default min-width:auto —
                      without it, a long unbroken line (a URL, a long word) refuses to
                      shrink and forces the row wider than the screen, pushing the
                      stage pill and delete (X) button off-screen on a phone. */}
                  <div style={{ flex: '1 1 160px', minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '0.62rem', fontWeight: 600, letterSpacing: '0.04em', color: C.brass, textTransform: 'uppercase' }}>{channelLabel(i.channel)}</span>
                      <span style={{ fontSize: '0.78rem', fontWeight: 600 }}>{i.from_name}</span>
                    </div>
                    <div style={{ fontSize: '0.83rem', marginTop: '0.15rem', overflowWrap: 'break-word', wordBreak: 'break-word' }}>{i.message}</div>
                  </div>
                  <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexShrink: 0, marginLeft: 'auto' }}>
                    <button onClick={() => onCycle(i.id)} style={{ ...pillBtn(stageColor[i.stage]), flexShrink: 0 }}>{inboxStageLabel(i.stage)}</button>
                    <button onClick={() => onRemove(i.id)} style={{ ...ghostBtn, flexShrink: 0 }}><X size={13} color={C.walnutSoft} /></button>
                  </div>
                </div>

                {canReply && !drafting && (
                  <button
                    onClick={() => onStartReply(i.id)}
                    style={{ ...ghostBtn, alignSelf: 'flex-start', fontSize: '0.72rem', color: C.brass, display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}
                  >
                    <Reply size={12} /> Jarvis, suggest a reply
                  </button>
                )}

                {drafting && (
                  <div style={{ background: C.tweed, border: `1px solid ${C.line}`, borderRadius: 10, padding: '0.5rem' }}>
                    {replyBusy && !replyDraftText ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.78rem', color: C.walnutSoft, padding: '0.3rem 0' }}>
                        <Loader2 size={13} className="animate-spin" /> Drafting a reply…
                      </div>
                    ) : (
                      <textarea
                        value={replyDraftText}
                        onChange={(e) => setReplyDraftText(e.target.value)}
                        rows={4}
                        style={{ ...inputStyle, width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
                      />
                    )}
                    {replyDraftErr && (
                      <p style={{ fontSize: '0.72rem', color: C.walnutSoft, margin: '0.35rem 0 0' }}>{replyDraftErr}</p>
                    )}
                    <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.4rem' }}>
                      <button
                        onClick={onSendReply}
                        disabled={replyBusy || !replyDraftText.trim()}
                        style={{ ...pillBtn(C.sage), display: 'inline-flex', alignItems: 'center', gap: '0.3rem', opacity: replyBusy || !replyDraftText.trim() ? 0.6 : 1 }}
                      >
                        <Send size={12} /> Send
                      </button>
                      <button onClick={onCancelReply} disabled={replyBusy} style={{ ...pillBtn(C.walnutSoft) }}>Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {visibleInbox.length === 0 && <EmptyNote text="Nothing logged yet — add an inquiry as it comes in." />}
          {visibleInbox.length > 0 && visible.length === 0 && <EmptyNote text="Nothing in this channel." />}
        </div>
      </div>
    </Card>
  );
}
