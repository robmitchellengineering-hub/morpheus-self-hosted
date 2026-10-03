import { useEffect, useRef, useState } from 'react';
import { Mic, Volume2, VolumeX, Send, FileText, Loader2, ExternalLink, X, Paperclip, Image as ImageIcon, Sparkles } from 'lucide-react';
import { useCommandDeck } from '@/contexts/CommandDeckContext';
import { useMorpheusVoice } from '@/hooks/useMorpheusVoice';
import { useSpeechRecognition } from '@/hooks/useSpeechRecognition';
import { jarvisElapsedSeconds, jarvisRemainingSeconds, formatElapsed } from '@/lib/jarvisStream';
import { C } from './deckConstants';
import { inputStyle, IconButton, pillBtn, ghostBtn, MicField } from './DeckUI';
import { safeFilename, textToCsv, paragraphs, looksTabular } from './exportDoc';

// Jarvis's own full-screen page (its own bottom tab) — voice input via the
// browser's SpeechRecognition and voice output via Morpheus's own existing
// TTS pipeline (useMorpheusVoice/generateMorpheusSpeech — already built for
// Morpheus's own chat, fully generic, reused here unchanged). The
// "connect the dots" one-shot synthesis and brain-dump auto-filing are a
// later phase (see the Command Deck Phase 2 plan) — this page is the full
// voice+text conversation.
//
// 2026-10-04 (Rob: *"i think the problem is it doesnt look like its doing anything ... i want to see it
// earlier and being written"*) — the turn in flight is now VISIBLE twice over: a labelled step with a
// live clock and the server's own ETA (JarvisLiveStatus below, where "Jarvis is thinking…" used to sit
// unchanged for a minute), and the reply itself, word by word, in a bubble that updates as it is
// written. Both come from the events chatWithJarvis streams (see CommandDeckContext.sendJarvisMessage).
export default function DeckJarvis() {
  const {
    jarvisMessages, jarvisInput, setJarvisInput, jarvisSending, jarvisErr, sendJarvisMessage, jarvisLive,
    docBusy, docErr, docResult, createDeckDocument, uploadFile,
  } = useCommandDeck();
  const { speak, stop, speakStreamStart, speakStreamText, speakStreamEnd, speakingId, loadingId } = useMorpheusVoice();

  // ---- exporting a reply --------------------------------------------------
  // The old base44 Deck's DocumentSheet could emit a PDF, Word and Excel file from any reply; this one
  // could only produce a Google Doc (audit §4). These are the client-side formats coming back, built on
  // the pure helpers in ./exportDoc so the deciding is guarded and only the drawing lives here.
  const docName = (m) => safeFilename(String(m.content || '').split(/\s+/).slice(0, 6).join(' '));

  const download = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoked on a delay: revoking immediately can cancel the download in some browsers.
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const exportCsv = (m) => download(new Blob([textToCsv(m.content)], { type: 'text/csv;charset=utf-8' }), `${docName(m)}.csv`);

  const exportWord = (m) => {
    const escapeHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const body = paragraphs(m.content).map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
    download(new Blob([`<html><head><meta charset="utf-8"></head><body>${body}</body></html>`], { type: 'application/msword' }), `${docName(m)}.doc`);
  };

  // jspdf is already a dependency, imported dynamically so it is not in the main bundle for a reply
  // nobody exports.
  const exportPdf = async (m) => {
    const { jsPDF } = await import('jspdf');
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const margin = 48;
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const width = pageWidth - margin * 2;
    let y = margin;
    doc.setFontSize(11);
    for (const para of paragraphs(m.content)) {
      for (const line of doc.splitTextToSize(para, width)) {
        if (y > pageHeight - margin) { doc.addPage(); y = margin; }
        doc.text(line, margin, y);
        y += 15;
      }
      y += 8;
    }
    doc.save(`${docName(m)}.pdf`);
  };

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
  }, [jarvisMessages, jarvisSending, jarvisLive?.text]);

  // ---- speaking, behind the stream ----------------------------------------
  // Rob, 2026-10-04: *"if it can start reading behind the streamed output even better"*. With the
  // speaker unmuted, the reply is spoken SENTENCE BY SENTENCE as it is written rather than after it
  // finishes. Where a sentence ends is the pure `nextSpeakableSegment` (src/lib/jarvisSpeech.js) and the
  // playing is `useMorpheusVoice`'s own queue, so nothing here decides either.
  //
  // The whole-message effect below still matters: suggestions (`jarvis_synthesis`) are not streamed, and
  // a reply that WAS streamed must not be read out twice. `lastSpokenId` is set from the streamed
  // reply's own id the moment it exists, which is what suppresses the second reading.
  const spokenStreamRef = useRef(null);
  useEffect(() => {
    if (!autoSpeak || !jarvisLive?.turnId) return;
    if (jarvisLive.replyId) lastSpokenId.current = jarvisLive.replyId;
    if (spokenStreamRef.current === jarvisLive.turnId) return;
    spokenStreamRef.current = jarvisLive.turnId;
    speakStreamStart(jarvisLive.turnId);
  }, [autoSpeak, jarvisLive?.turnId, jarvisLive?.replyId, speakStreamStart]);

  useEffect(() => {
    if (!autoSpeak || !jarvisLive?.turnId) return;
    speakStreamText(jarvisLive.turnId, jarvisLive.text || '');
  }, [autoSpeak, jarvisLive?.turnId, jarvisLive?.text, speakStreamText]);

  useEffect(() => {
    if (!autoSpeak || !jarvisLive?.turnId || !jarvisLive.done) return;
    speakStreamEnd(jarvisLive.turnId, jarvisLive.text || '');
  }, [autoSpeak, jarvisLive?.turnId, jarvisLive?.done, jarvisLive?.text, speakStreamEnd]);

  // Auto-speak a reply that arrived whole — a suggestion, or a turn where streaming was not used.
  useEffect(() => {
    if (!autoSpeak) return;
    const last = jarvisMessages[jarvisMessages.length - 1];
    if (!last || last.role === 'user') return;
    if (last.id === lastSpokenId.current) return;
    lastSpokenId.current = last.id;
    speak(last);
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
            <MicField
              value={docInstruction}
              onChange={setDocInstruction}
              onSubmit={() => createDeckDocument(docInstruction)}
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
          <div
            key={m.id}
            style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '88%', display: 'flex', flexDirection: 'column', alignItems: m.role === 'user' ? 'flex-end' : 'flex-start', gap: '0.25rem' }}
          >
          <button
            onClick={() => (speakingId === m.id ? stop() : speak(m))}
            style={{
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
          {/* Downloads sit OUTSIDE the message button — it is a button already (tap to hear), and a
              button inside a button is invalid and swallows the tap. */}
          {m.role !== 'user' && (
            <div style={{ display: 'flex', gap: '0.3rem' }}>
              {[['PDF', () => exportPdf(m)], ['Word', () => exportWord(m)]].map(([label, run]) => (
                <button key={label} onClick={run} style={{ ...ghostBtn, fontSize: '0.66rem', color: 'rgba(246,240,223,0.6)', padding: '0.15rem 0.4rem' }}>{label}</button>
              ))}
              {/* A spreadsheet is only offered when the reply actually looks like a table. */}
              {looksTabular(m.content) && (
                <button onClick={() => exportCsv(m)} style={{ ...ghostBtn, fontSize: '0.66rem', color: 'rgba(246,240,223,0.6)', padding: '0.15rem 0.4rem' }}>CSV</button>
              )}
            </div>
          )}
          </div>
        ))}
        {jarvisSending && <JarvisLiveStatus live={jarvisLive} />}
        {/* The words, as they are written. It is not a `<button>` like a finished reply: there is
            nothing to play yet and nothing to export, and the whole reply replaces this bubble the
            moment the terminal event lands — including a length-budget repair, which is why what is
            shown here is a draft and what ends up in the list is the stored text. */}
        {jarvisSending && jarvisLive?.text && (
          <div
            style={{
              alignSelf: 'flex-start', maxWidth: '88%', background: 'rgba(246,240,223,0.08)',
              border: '1px solid rgba(246,240,223,0.15)', borderRadius: 10, padding: '0.55rem 0.7rem',
              fontSize: '0.85rem', lineHeight: 1.5, whiteSpace: 'pre-wrap', color: C.paper,
              textAlign: 'left', fontFamily: "'Lexend', sans-serif",
            }}
          >
            {jarvisLive.text}
            <span style={{ opacity: 0.55 }}>▍</span>
          </div>
        )}
      </div>

      {jarvisErr && (
        <p style={{ fontSize: '0.75rem', color: C.alert, marginTop: '0.5rem', marginBottom: 0 }}>
          {jarvisLive?.error || "Couldn't reach Jarvis that time — give it another go."}
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

/**
 * The turn in flight, named and timed.
 *
 * WHY THIS IS A COMPONENT AND NOT ONE LINE OF TEXT. It used to be the constant string "Jarvis is
 * thinking…", which is indistinguishable from a hung page: the operator had no step name, no clock and
 * no evidence anything was happening for as long as the model took. That is UI feedback rule 1 (no
 * silent work) and rule 10 (a long wait must look alive) broken by Morpheus's own surface.
 *
 * Everything shown is something the server actually said or a clock: `label` is the current stage event,
 * `remaining` is the deployment's own measured ETA for that step (lib/timingStats.js), and `elapsed` is
 * real seconds. The 1s interval exists only to move the clock — a number that never changes is not
 * evidence of life.
 */
function JarvisLiveStatus({ live }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  const elapsed = jarvisElapsedSeconds(live);
  const remaining = jarvisRemainingSeconds(live);

  return (
    <div style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.78rem', color: C.gold }}>
      <Loader2 size={13} className="animate-spin" />
      <span>{live?.label || 'Sending…'}</span>
      <span style={{ color: 'rgba(246,240,223,0.55)', fontVariantNumeric: 'tabular-nums' }}>{formatElapsed(elapsed)}</span>
      {remaining != null && (
        <span style={{ color: 'rgba(246,240,223,0.45)', fontVariantNumeric: 'tabular-nums' }}>
          {remaining > 0 ? `~${formatElapsed(remaining)} left` : 'finishing…'}
        </span>
      )}
    </div>
  );
}
