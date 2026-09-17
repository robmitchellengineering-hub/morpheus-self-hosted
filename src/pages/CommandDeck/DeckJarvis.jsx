import { useEffect, useRef, useState } from 'react';
import { Mic, Volume2, VolumeX, Send, FileText, Loader2, ExternalLink, X, Paperclip, Image as ImageIcon, Sparkles } from 'lucide-react';
import { useCommandDeck } from '@/contexts/CommandDeckContext';
import { useMorpheusVoice } from '@/hooks/useMorpheusVoice';
import { useSpeechRecognition } from '@/hooks/useSpeechRecognition';
import { C } from './deckConstants';
import { inputStyle, IconButton, pillBtn, ghostBtn } from './DeckUI';

// Jarvis's own full-screen page (its own bottom tab) — voice input via the
// browser's SpeechRecognition and voice output via Morpheus's own existing
// TTS pipeline (useMorpheusVoice/generateMorpheusSpeech — already built for
// Morpheus's own chat, fully generic, reused here unchanged). The
// "connect the dots" one-shot synthesis and brain-dump auto-filing are a
// later phase (see the Command Deck Phase 2 plan) — this page is the full
// voice+text conversation.
export default function DeckJarvis() {
  const {
    jarvisMessages, jarvisInput, setJarvisInput, jarvisSending, jarvisErr, sendJarvisMessage,
    docBusy, docErr, docResult, createDeckDocument, uploadFile,
  } = useCommandDeck();
  const { speak, stop, speakingId, loadingId } = useMorpheusVoice();
  const [autoSpeak, setAutoSpeak] = useState(false);
  const [showDocForm, setShowDocForm] = useState(false);
  const [docInstruction, setDocInstruction] = useState('Summarize our conversation');
  const [attachments, setAttachments] = useState([]); // [{name, url}] — pending, cleared once sent
  const [attachBusy, setAttachBusy] = useState(false);
  const listRef = useRef(null);
  const lastSpokenId = useRef(null);
  const fileInputRef = useRef(null);

  const handleAttach = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = ''; // allow attaching the same file again later
    if (files.length === 0) return;
    setAttachBusy(true);
    try {
      const uploaded = await Promise.all(files.map(async (file) => ({ name: file.name, url: await uploadFile(file) })));
      setAttachments((prev) => [...prev, ...uploaded]);
    } catch {
      // Best-effort — a failed upload just doesn't get attached; the
      // message can still be sent as plain text.
    }
    setAttachBusy(false);
  };
  const removeAttachment = (url) => setAttachments((prev) => prev.filter((a) => a.url !== url));

  const { listening, start, stop: stopListening, supported: micSupported } = useSpeechRecognition({
    onResult: (transcript) => {
      setJarvisInput(transcript);
      sendJarvisMessageWithText(transcript);
    },
  });

  // sendJarvisMessage always reads the current jarvisInput state via the
  // context, so voice results are sent through the same setJarvisInput +
  // sendJarvisMessage() pair a typed message uses — just triggered a tick
  // later once the input state has actually updated.
  const sendJarvisMessageWithText = (text) => {
    setJarvisInput(text);
    window.setTimeout(() => sendJarvisMessage(), 0);
  };

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [jarvisMessages, jarvisSending]);

  // Auto-speak Jarvis's own newest reply when the speaker is unmuted.
  useEffect(() => {
    if (!autoSpeak) return;
    const last = jarvisMessages[jarvisMessages.length - 1];
    if (last?.role === 'jarvis' && last.id !== lastSpokenId.current) {
      lastSpokenId.current = last.id;
      speak(last);
    }
  }, [jarvisMessages, autoSpeak, speak]);

  const handleMicClick = () => {
    if (listening) stopListening();
    else start();
  };

  const handleSend = () => {
    sendJarvisMessage(attachments.map((a) => a.url));
    setAttachments([]);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 'calc(100vh - 9.5rem)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginTop: '0.9rem', marginBottom: '0.6rem' }}>
        <div>
          <h2 style={{ fontWeight: 600, fontSize: '1.15rem', margin: 0, color: C.walnut }}>Jarvis</h2>
          <p style={{ margin: '0.2rem 0 0', fontSize: '0.78rem', color: C.walnutSoft }}>Voice or text — he's got the whole picture.</p>
        </div>
        <div style={{ display: 'flex', gap: '0.4rem', flexShrink: 0 }}>
          <button
            onClick={() => setShowDocForm((v) => !v)}
            title="Create a document"
            style={{ width: 38, height: 38, borderRadius: 10, border: `1px solid ${C.line}`, background: showDocForm ? C.gold : C.paper, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
          >
            <FileText size={16} color={C.walnut} />
          </button>
          <button
            onClick={() => { setAutoSpeak((v) => !v); if (autoSpeak) stop(); }}
            title={autoSpeak ? 'Mute Jarvis' : 'Unmute Jarvis'}
            style={{ width: 38, height: 38, borderRadius: 10, border: `1px solid ${C.line}`, background: autoSpeak ? C.gold : C.paper, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
          >
            {autoSpeak ? <Volume2 size={17} color={C.walnut} /> : <VolumeX size={17} color={C.walnutSoft} />}
          </button>
        </div>
      </div>

      {showDocForm && (
        <div style={{ background: C.paper, border: `1px solid ${C.line}`, borderRadius: 12, padding: '0.7rem 0.8rem', marginBottom: '0.6rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
            <span style={{ fontSize: '0.78rem', fontWeight: 600, color: C.walnut }}>Create a document</span>
            <button onClick={() => setShowDocForm(false)} style={ghostBtn}><X size={14} color={C.walnutSoft} /></button>
          </div>
          <p style={{ margin: '0 0 0.5rem', fontSize: '0.72rem', color: C.walnutSoft }}>
            Jarvis drafts it from your instruction plus recent conversation — a summary, a letter, a table, research, whatever you need.
          </p>
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            <input
              value={docInstruction}
              onChange={(e) => setDocInstruction(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && createDeckDocument(docInstruction)}
              placeholder="What should this document be?"
              disabled={docBusy}
              style={{ ...inputStyle, flex: 1 }}
            />
            <button
              onClick={() => createDeckDocument(docInstruction)}
              disabled={docBusy || !docInstruction.trim()}
              style={{ ...pillBtn(C.brass), display: 'inline-flex', alignItems: 'center', gap: '0.3rem', opacity: docBusy || !docInstruction.trim() ? 0.6 : 1 }}
            >
              {docBusy ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
              {docBusy ? 'Drafting…' : 'Create'}
            </button>
          </div>
          {docErr && <p style={{ margin: '0.5rem 0 0', fontSize: '0.75rem', color: C.alert }}>{docErr}</p>}
          {docResult?.url && (
            <a
              href={docResult.url} target="_blank" rel="noreferrer"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', marginTop: '0.6rem', fontSize: '0.78rem', fontWeight: 600, color: C.sage, textDecoration: 'none' }}
            >
              <ExternalLink size={13} /> Open "{docResult.title}"
            </a>
          )}
        </div>
      )}

      <div
        ref={listRef}
        style={{
          flex: 1, display: 'flex', flexDirection: 'column', gap: '0.55rem', overflowY: 'auto',
          background: C.walnut, borderRadius: 16, padding: '0.9rem', minHeight: 260, maxHeight: 'calc(100vh - 20rem)',
        }}
      >
        {jarvisMessages.length === 0 && (
          <div style={{ alignSelf: 'flex-start', maxWidth: '88%', background: 'rgba(246,240,223,0.08)', border: '1px solid rgba(246,240,223,0.15)', borderRadius: 10, padding: '0.6rem 0.75rem', fontSize: '0.85rem', color: C.paper, lineHeight: 1.5 }}>
            Hey — I'm Jarvis. Tap the mic and just talk, or type. What's on your mind?
          </div>
        )}
        {jarvisMessages.map((m) => (
          <button
            key={m.id}
            onClick={() => (speakingId === m.id ? stop() : speak(m))}
            style={{
              alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '88%',
              background: m.role === 'user' ? C.brass : 'rgba(246,240,223,0.08)',
              border: m.role === 'user' ? 'none' : `1px solid ${speakingId === m.id ? C.gold : 'rgba(246,240,223,0.15)'}`,
              borderRadius: 10,
              padding: '0.55rem 0.7rem',
              fontSize: '0.85rem',
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              color: C.paper,
              textAlign: 'left',
              cursor: 'pointer',
              fontFamily: "'Lexend', sans-serif",
            }}
            title="Tap to hear this"
          >
            {m.role === 'jarvis_synthesis' && (
              <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.68rem', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: C.gold, marginBottom: '0.3rem' }}>
                <Sparkles size={11} /> Suggestions
              </span>
            )}
            {m.content}
            {loadingId === m.id && <span style={{ opacity: 0.6 }}> …</span>}
          </button>
        ))}
        {jarvisSending && (
          <div style={{ alignSelf: 'flex-start', fontSize: '0.78rem', color: 'rgba(246,240,223,0.5)' }}>Jarvis is thinking…</div>
        )}
      </div>

      {jarvisErr && (
        <p style={{ fontSize: '0.75rem', color: C.alert, marginTop: '0.5rem', marginBottom: 0 }}>
          Couldn't reach Jarvis that time — give it another go.
        </p>
      )}

      {attachments.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginTop: '0.6rem' }}>
          {attachments.map((a) => (
            <span
              key={a.url}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', background: C.paper, border: `1px solid ${C.line}`, borderRadius: 999, padding: '0.25rem 0.5rem 0.25rem 0.6rem', fontSize: '0.72rem', color: C.walnut }}
            >
              {/\.(png|jpe?g|gif|webp|bmp)$/i.test(a.name) ? <ImageIcon size={12} /> : <FileText size={12} />}
              {a.name}
              <button onClick={() => removeAttachment(a.url)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', padding: 0 }}>
                <X size={12} color={C.walnutSoft} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.7rem' }}>
        {micSupported && (
          <IconButton onClick={handleMicClick} color={listening ? C.alert : C.oxblood}>
            <Mic size={18} color={C.paper} />
          </IconButton>
        )}
        <IconButton onClick={() => fileInputRef.current?.click()} color={attachBusy ? C.walnutSoft : C.walnut} disabled={attachBusy}>
          {attachBusy ? <Loader2 size={16} className="animate-spin" color={C.paper} /> : <Paperclip size={17} color={C.paper} />}
        </IconButton>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,.pdf,.doc,.docx,.xls,.xlsx"
          onChange={handleAttach}
          style={{ display: 'none' }}
        />
        <input
          value={jarvisInput}
          onChange={(e) => setJarvisInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          placeholder={listening ? 'Listening…' : 'Type, tap the mic, or attach a file…'}
          disabled={jarvisSending}
          style={inputStyle}
        />
        <IconButton onClick={handleSend} color={C.brass} disabled={jarvisSending || (!jarvisInput.trim() && attachments.length === 0)}>
          <Send size={17} color={C.paper} />
        </IconButton>
      </div>
    </div>
  );
}
