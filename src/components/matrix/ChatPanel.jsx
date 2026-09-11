import { useEffect, useRef, useState } from 'react';
import { Send, Mic, MicOff, Volume2, VolumeX, Play, Loader2, Paperclip, X, Undo2, AlertTriangle, Bot, MessagesSquare, Hammer, Globe } from 'lucide-react';
import { useSpeechRecognition } from '@/hooks/useSpeechRecognition';
import { useMorpheusVoice } from '@/hooks/useMorpheusVoice';
import { base44 } from '@/api/base44Client';
import HelpHint from '@/components/matrix/HelpHint';
import MorpheusThinking from '@/components/matrix/MorpheusThinking';
import MorpheusPipelineStatus from '@/components/matrix/MorpheusPipelineStatus';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
// How tall the chat input is allowed to grow as the operator types (px)
// before it switches to scrolling internally instead of growing further —
// generous enough that a long message stays fully visible/editable, capped
// so it can't push the send row off-screen on a small viewport.
const MAX_TEXTAREA_HEIGHT = 240;

export default function ChatPanel({ messages, loading, pipelineStages, onSend, onRevert, canRevert, onAutonomous, chatMode, onSetChatMode, webAccess, onSetWebAccess }) {
  // CONTEXT ⇄ BUILD toggle is only rendered when the host wired it up
  // (Workspace / Self-Dev). Undefined chatMode => treat as 'build', hide the
  // strip entirely — keeps every other ChatPanel caller unchanged.
  const modeEnabled = typeof onSetChatMode === 'function';
  const mode = chatMode === 'context' ? 'context' : 'build';
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [attachments, setAttachments] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [revertConfirm, setRevertConfirm] = useState(false);
  const [reverting, setReverting] = useState(false);
  const fileInputRef = useRef(null);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  // Auto-expand the chat textarea as the operator types (so a long message
  // stays fully visible and editable before sending), then collapse it back
  // to a single line once the message is sent. Kept as a plain DOM height
  // mutation rather than tracked React state since the textarea itself stays
  // uncontrolled (see inputRef usage below, including voice input).
  const resizeTextarea = () => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT) + 'px';
  };

  const lastUserIdx = messages.map(m => m.role).lastIndexOf('user');

  const handleRevert = async () => {
    setReverting(true);
    try { await onRevert(); } finally { setReverting(false); setRevertConfirm(false); }
  };

  const { speak, stop, speakingId, loadingId } = useMorpheusVoice();

  const { listening, start, stop: stopListening, supported: micSupported } = useSpeechRecognition({
    onResult: (text) => { if (inputRef.current) { inputRef.current.value = text; resizeTextarea(); } }
  });

  // 2026-09-03 (Rob: "I have to scroll down to see the action happening"):
  // this was already scrolling to bottom on send, but `pipelineStages`
  // wasn't in the dependency list — so it only fired once when loading
  // started, then never again as new stage lines (Planning -> Writing the
  // code -> Reviewing -> ...) got appended underneath over the next tens of
  // seconds. The visible bottom kept moving down without the scroll
  // following it, so the operator had to manually scroll to see whichever
  // step was actually running. Tracking pipelineStages here re-scrolls on
  // every stage start/finish, not just the first one.
  //
  // 2026-09-11 (Rob: "every time I log into self dev I see this page and
  // not what I've just been doing"): this ran synchronously in the effect
  // body, reading scrollHeight in the same tick as the state update — fine
  // for a couple of new lines appended to an already-rendered list, but
  // switching projects (or the initial load) replaces the whole list in
  // one jump (0 -> up to 100 messages), and the browser hadn't necessarily
  // finished laying out all of them out yet when scrollHeight was read, so
  // the scroll could land short of the real bottom. A double rAF — one to
  // let the paint this render triggered land, one more to guarantee layout
  // is committed before measuring — is the standard fix for "just-rendered
  // DOM height" races like this.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
    });
    return () => cancelAnimationFrame(id);
  }, [messages, loading, speakingId, pipelineStages]);

  const handleSend = () => {
    const text = inputRef.current?.value || '';
    if ((!text.trim() && attachments.length === 0) || loading) return;
    stop();
    const fileUrls = attachments.map(a => a.url);
    onSend(text, fileUrls);
    if (inputRef.current) inputRef.current.value = '';
    resizeTextarea();
    setAttachments([]);
  };

  const handleFileSelect = async (e) => {
    const selected = Array.from(e.target.files || []);
    e.target.value = '';
    if (selected.length === 0) return;

    const valid = selected.filter(f => f.size <= MAX_FILE_SIZE);
    if (valid.length < selected.length) {
      alert('Some files exceeded 10MB and were skipped.');
    }
    if (valid.length === 0) return;

    setUploading(true);
    try {
      const uploaded = await Promise.all(
        valid.map(async f => {
          const { file_url } = await base44.integrations.Core.UploadFile({ file: f });
          return { name: f.name, url: file_url };
        })
      );
      setAttachments(prev => [...prev, ...uploaded]);
    } catch (err) {
      alert('Upload failed: ' + err.message);
    } finally {
      setUploading(false);
    }
  };

  const removeAttachment = (idx) => {
    setAttachments(prev => prev.filter((_, i) => i !== idx));
  };

  const handleMicClick = () => {
    stop();
    if (listening) stopListening();
    else start();
  };

  const toggleVoice = () => {
    if (voiceEnabled) stop();
    setVoiceEnabled(!voiceEnabled);
  };

  return (
    <div className="flex flex-col h-full w-full">
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-matrix">
        {messages.length === 0 && !loading && (
          <div className="text-primary/75 italic text-sm space-y-1">
            <p>&gt; Morpheus is here.</p>
            <p>&gt; Tell me what you want to build. I can only show you the door.</p>
          </div>
        )}
        {messages.map((m, idx) => (
          <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
            <div className={`max-w-[85%] ${m.role === 'user' ? 'text-[#39ff14]/80' : 'text-primary'}`}>
              <div className="flex items-center gap-2">
                <span className="text-xs text-primary/75">{m.role === 'user' ? 'operator@matrix:~$' : 'morpheus@construct:~$'}</span>
                {m.role === 'morpheus' && !m.content.startsWith('// SYSTEM') && (
                  <button
                    onClick={() => speak(m)}
                    className="text-primary/75 hover:text-primary transition-colors"
                    title="Play voice"
                  >
                    {loadingId === m.id ? <Loader2 size={12} className="animate-spin" /> :
                     speakingId === m.id ? <Volume2 size={12} className="animate-pulse" /> :
                     <Play size={12} />}
                  </button>
                )}
              </div>
              <div className="whitespace-pre-wrap break-words text-sm mt-1">
                {m.content.split('\n').map((line, li) => {
                  const isCritical = line.startsWith('// CRITICAL');
                  return (
                    <p key={li} className={isCritical ? 'text-red-500 font-semibold' : ''}>{line || '\u00A0'}</p>
                  );
                })}
              </div>
              {idx === lastUserIdx && m.role === 'user' && canRevert && (
                <div className="mt-1.5 flex justify-end">
                  {!revertConfirm ? (
                    <button
                      onClick={() => setRevertConfirm(true)}
                      disabled={reverting}
                      className="flex items-center gap-1 text-[10px] text-primary/60 hover:text-primary border border-primary/30 hover:border-primary/60 px-2 py-0.5 transition-colors disabled:opacity-40"
                      title="Revert to before this prompt"
                    >
                      <Undo2 size={11} /> REVERT
                    </button>
                  ) : (
                    <div className="flex items-center gap-1.5 border border-yellow-500/50 bg-yellow-500/10 px-2 py-1">
                      <AlertTriangle size={11} className="text-yellow-500 shrink-0" />
                      <span className="text-[10px] text-yellow-500/90">Undo last prompt & restore code?</span>
                      <button
                        onClick={handleRevert}
                        disabled={reverting}
                        className="text-[10px] text-black bg-yellow-500 hover:bg-yellow-400 px-2 py-0.5 font-bold disabled:opacity-50"
                      >
                        {reverting ? <Loader2 size={10} className="animate-spin" /> : 'YES'}
                      </button>
                      <button
                        onClick={() => setRevertConfirm(false)}
                        disabled={reverting}
                        className="text-[10px] text-primary/70 hover:text-primary px-1.5 py-0.5 border border-primary/30 disabled:opacity-50"
                      >
                        NO
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="text-primary/60 text-sm max-w-[85%]">
              {/* Show the plain thinking indicator only while the planner is
                  still running — at that point we don't yet know if this is a
                  build or just a chat answer. The moment the planner finishes
                  (or any later stage starts) we know, and show the step list:
                  for a real build that's the pipeline; for a chat-only turn
                  the planner step flashes for an instant before the reply
                  replaces the whole loading block. Command Deck 4.0: "no
                  build pipeline display when only chatting". Context mode
                  emits no stages and lands in the thinking branch. */}
              {pipelineStages && pipelineStages.some((s) => s.stage !== 'planner' || s.status === 'done') ? (
                <>
                  <div className="text-primary/75 mb-1">morpheus@construct:~$</div>
                  <MorpheusPipelineStatus stages={pipelineStages} />
                </>
              ) : (
                <>
                  <span className="text-primary/75 mr-2">morpheus@construct:~$</span>
                  <MorpheusThinking />
                </>
              )}
            </div>
          </div>
        )}
      </div>
      {attachments.length > 0 && (
        <div className="border-t border-primary/20 px-3 pt-2 flex flex-wrap gap-2">
          {attachments.map((a, i) => (
            <div key={i} className="flex items-center gap-1.5 border border-primary/40 bg-primary/5 px-2 py-1 text-xs">
              <Paperclip size={10} className="text-primary/60 shrink-0" />
              <span className="text-primary/80 truncate max-w-[120px]">{a.name}</span>
              <button onClick={() => removeAttachment(i)} className="text-primary/75 hover:text-red-500 shrink-0">
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <input ref={fileInputRef} type="file" multiple onChange={handleFileSelect} className="hidden" accept="image/*,.pdf,.txt,.md,.json,.js,.jsx,.ts,.tsx,.css,.html,.xml,.py,.java,.kt,.swift,.go,.rs,.c,.cpp,.h,.yml,.yaml,.toml,.csv" />
      {modeEnabled && (
        <div className="border-t border-primary/20 px-3 py-2 flex items-center gap-2">
          <div className="flex border border-primary/30 shrink-0">
            <button
              onClick={() => onSetChatMode('context')}
              disabled={loading}
              className={`flex items-center gap-1.5 text-[11px] tracking-wider px-2.5 py-1 transition-colors disabled:opacity-40 ${mode === 'context' ? 'text-black bg-primary font-bold' : 'text-primary/60 hover:text-primary'}`}
              title="Discuss and plan — Morpheus never writes code in this mode"
            >
              <MessagesSquare size={12} /> CONTEXT
            </button>
            <button
              onClick={() => onSetChatMode('build')}
              disabled={loading}
              className={`flex items-center gap-1.5 text-[11px] tracking-wider px-2.5 py-1 transition-colors disabled:opacity-40 border-l border-primary/30 ${mode === 'build' ? 'text-black bg-primary font-bold' : 'text-primary/60 hover:text-primary'}`}
              title="Full build pipeline — plan, code, review"
            >
              <Hammer size={12} /> BUILD
            </button>
          </div>
          {typeof onSetWebAccess === 'function' && (
            <button
              onClick={() => onSetWebAccess(!webAccess)}
              disabled={loading}
              className={`flex items-center gap-1.5 text-[11px] tracking-wider border px-2.5 py-1 shrink-0 transition-colors disabled:opacity-40 ${webAccess ? 'text-black bg-primary font-bold border-primary' : 'text-primary/60 hover:text-primary border-primary/30'}`}
              title="Let Morpheus search the web and read pasted URLs before answering — for current library/API info the project files don't have. Free sources always; a Gemini key adds Google-grounded search."
            >
              <Globe size={12} /> WEB
            </button>
          )}
          <span className="text-[10px] text-primary/50 leading-tight">
            {mode === 'context'
              ? '// chat & shape the plan — nothing gets built or written'
              : '// planner → coder → reviewer — changes are written to the workspace'}
          </span>
        </div>
      )}
      <div className="border-t border-primary/40 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] flex gap-2 items-center shadow-[0_-6px_24px_-6px_rgba(0,255,65,0.35)]">
        <button onClick={toggleVoice} className="text-primary/60 hover:text-primary shrink-0" title={voiceEnabled ? 'Mute Morpheus' : 'Unmute Morpheus'}>
          {voiceEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
        </button>
        <button onClick={() => fileInputRef.current?.click()} disabled={loading || uploading} className="text-primary/80 hover:text-primary shrink-0 disabled:opacity-30 p-1 border border-primary/30 hover:border-primary/60 transition-colors" title="Attach reference file">
          {uploading ? <Loader2 size={18} className="animate-spin" /> : <Paperclip size={18} />}
        </button>
        <span className="text-primary/60">{'>'}</span>
        <textarea
          ref={inputRef}
          defaultValue=""
          rows={1}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
          onInput={resizeTextarea}
          placeholder={listening ? 'listening...' : modeEnabled && mode === 'context' ? 'discuss, plan, ask...' : 'speak...'}
          className="flex-1 min-w-0 resize-none bg-transparent text-primary placeholder:text-primary/65 outline-none text-sm leading-5 py-0.5 overflow-y-auto scrollbar-matrix"
          disabled={loading}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        {onAutonomous && (
          <HelpHint id="chat-auto" title="Autonomous Build" body="Give Morpheus a spec and it runs a multi-step build loop — planning, coding, reviewing — until the project is complete. Watch the log in real time. Uses more AI credits.">
            <button onClick={onAutonomous} disabled={loading} className="shrink-0 p-1.5 border border-primary/40 hover:border-primary hover:bg-primary/10 text-primary transition-colors disabled:opacity-30" title="Autonomous build">
              <Bot size={16} />
            </button>
          </HelpHint>
        )}
        {micSupported && (
          <button onClick={handleMicClick} className={`shrink-0 p-1.5 border transition-colors ${listening ? 'text-black bg-primary border-primary animate-pulse' : 'text-primary border-primary/40 hover:border-primary'}`} title="Voice input">
            {listening ? <MicOff size={16} /> : <Mic size={16} />}
          </button>
        )}
        <HelpHint id="chat-send" title="Build with Morpheus" body="Tell Morpheus what to build or change. He plans the architecture, writes production-ready code, and reviews it before saving. Attach reference files with the paperclip, or use voice input with the mic. Press Enter to send.">
          <button onClick={handleSend} disabled={loading} className="text-primary hover:text-black hover:bg-primary px-3 py-1 border border-primary/40 disabled:opacity-30 transition-colors">
            <Send size={16} />
          </button>
        </HelpHint>
      </div>
    </div>
  );
}