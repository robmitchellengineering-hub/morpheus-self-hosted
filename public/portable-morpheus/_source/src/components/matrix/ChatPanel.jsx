import { useEffect, useRef, useState } from 'react';
import { Send, Mic, MicOff, Volume2, VolumeX, Play, Loader2, Paperclip, X, Undo2, AlertTriangle, Wrench, Bot } from 'lucide-react';
import { useSpeechRecognition } from '@/hooks/useSpeechRecognition';
import { useMorpheusVoice } from '@/hooks/useMorpheusVoice';
import { base44 } from '@/api/base44Client';
import HelpHint from '@/components/matrix/HelpHint';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export default function ChatPanel({ messages, loading, onSend, onRevert, canRevert, onAutonomous }) {
  const [hasText, setHasText] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [attachments, setAttachments] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [revertConfirm, setRevertConfirm] = useState(false);
  const [reverting, setReverting] = useState(false);
  const fileInputRef = useRef(null);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  const lastUserIdx = messages.map(m => m.role).lastIndexOf('user');

  const handleRevert = async () => {
    setReverting(true);
    try { await onRevert(); } finally { setReverting(false); setRevertConfirm(false); }
  };

  const { speak, stop, speakingId, loadingId } = useMorpheusVoice();

  const { listening, start, stop: stopListening, supported: micSupported } = useSpeechRecognition({
    onResult: (text) => { if (inputRef.current) { inputRef.current.value = text; setHasText(text.trim().length > 0); } }
  });

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, loading, speakingId]);

  const handleSend = () => {
    const text = inputRef.current?.value || '';
    if ((!text.trim() && attachments.length === 0) || loading) return;
    stop();
    const fileUrls = attachments.map(a => a.url);
    onSend(text, fileUrls);
    if (inputRef.current) inputRef.current.value = '';
    setHasText(false);
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
          <div className="text-[#00ff41]/75 italic text-sm space-y-1">
            <p>&gt; Morpheus is here.</p>
            <p>&gt; Tell me what you want to build. I can only show you the door.</p>
          </div>
        )}
        {messages.map((m, idx) => (
          <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
            <div className={`max-w-[85%] ${m.role === 'user' ? 'text-[#39ff14]/80' : 'text-[#00ff41]'}`}>
              <div className="flex items-center gap-2">
                <span className="text-xs text-[#00ff41]/75">{m.role === 'user' ? 'operator@matrix:~$' : 'morpheus@construct:~$'}</span>
                {m.role === 'morpheus' && !m.content.startsWith('// SYSTEM') && (
                  <button
                    onClick={() => speak(m)}
                    className="text-[#00ff41]/75 hover:text-[#00ff41] transition-colors"
                    title="Play voice"
                  >
                    {loadingId === m.id ? <Loader2 size={12} className="animate-spin" /> :
                     speakingId === m.id ? <Volume2 size={12} className="animate-pulse" /> :
                     <Play size={12} />}
                  </button>
                )}
              </div>
              <p className="whitespace-pre-wrap break-words text-sm mt-1">{m.content}</p>
              {idx === lastUserIdx && m.role === 'user' && canRevert && (
                <div className="mt-1.5 flex justify-end">
                  {!revertConfirm ? (
                    <button
                      onClick={() => setRevertConfirm(true)}
                      disabled={reverting}
                      className="flex items-center gap-1 text-[10px] text-[#00ff41]/60 hover:text-[#00ff41] border border-[#00ff41]/30 hover:border-[#00ff41]/60 px-2 py-0.5 transition-colors disabled:opacity-40"
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
                        className="text-[10px] text-[#00ff41]/70 hover:text-[#00ff41] px-1.5 py-0.5 border border-[#00ff41]/30 disabled:opacity-50"
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
            <div className="text-[#00ff41]/60 text-sm">
              <span className="text-[#00ff41]/75 mr-2">morpheus@construct:~$</span>
              <span className="animate-pulse">decoding reality</span><span className="animate-pulse">_</span>
            </div>
          </div>
        )}
      </div>
      {attachments.length > 0 && (
        <div className="border-t border-[#00ff41]/20 px-3 pt-2 flex flex-wrap gap-2">
          {attachments.map((a, i) => (
            <div key={i} className="flex items-center gap-1.5 border border-[#00ff41]/40 bg-[#00ff41]/5 px-2 py-1 text-xs">
              <Paperclip size={10} className="text-[#00ff41]/60 shrink-0" />
              <span className="text-[#00ff41]/80 truncate max-w-[120px]">{a.name}</span>
              <button onClick={() => removeAttachment(i)} className="text-[#00ff41]/75 hover:text-red-500 shrink-0">
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <input ref={fileInputRef} type="file" multiple onChange={handleFileSelect} className="hidden" accept="image/*,.pdf,.txt,.md,.json,.js,.jsx,.ts,.tsx,.css,.html,.xml,.py,.java,.kt,.swift,.go,.rs,.c,.cpp,.h,.yml,.yaml,.toml,.csv" />
      {messages.length > 0 && !loading && (
        <div className="border-t border-[#00ff41]/20 px-3 pt-2 flex gap-2 flex-wrap">
          <button
            onClick={() => onSend("Address the issues from the review. Look at the critical issues flagged in the last review, fix every one of them in the affected files, and re-output the corrected code. Don't stop until all review issues are resolved and the code is clean.", [])}
            className="flex items-center gap-1.5 text-xs text-[#00ff41]/70 hover:text-[#00ff41] border border-[#00ff41]/30 hover:border-[#00ff41]/60 hover:bg-[#00ff41]/5 px-2.5 py-1 transition-colors"
          >
            <Wrench size={12} /> Fix review issues
          </button>
        </div>
      )}
      <div className="border-t border-[#00ff41]/20 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] flex gap-2 items-center">
        <button onClick={toggleVoice} className="text-[#00ff41]/60 hover:text-[#00ff41] shrink-0" title={voiceEnabled ? 'Mute Morpheus' : 'Unmute Morpheus'}>
          {voiceEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
        </button>
        <button onClick={() => fileInputRef.current?.click()} disabled={loading || uploading} className="text-[#00ff41]/80 hover:text-[#00ff41] shrink-0 disabled:opacity-30 p-1 border border-[#00ff41]/30 hover:border-[#00ff41]/60 transition-colors" title="Attach reference file">
          {uploading ? <Loader2 size={18} className="animate-spin" /> : <Paperclip size={18} />}
        </button>
        <span className="text-[#00ff41]/60">{'>'}</span>
        <input
          ref={inputRef}
          defaultValue=""
          onInput={e => setHasText(e.target.value.trim().length > 0)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
          placeholder={listening ? 'listening...' : 'speak...'}
          className="flex-1 bg-transparent text-[#00ff41] placeholder:text-[#00ff41]/65 outline-none text-sm"
          style={{ transform: 'translateZ(0)' }}
          disabled={loading}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        {onAutonomous && (
          <HelpHint id="chat-auto" title="Autonomous Build" body="Give Morpheus a spec and it runs a multi-step build loop — planning, coding, reviewing — until the project is complete. Watch the log in real time. Uses more AI credits.">
            <button onClick={onAutonomous} disabled={loading} className="shrink-0 p-1.5 border border-[#00ff41]/40 hover:border-[#00ff41] hover:bg-[#00ff41]/10 text-[#00ff41] transition-colors disabled:opacity-30" title="Autonomous build">
              <Bot size={16} />
            </button>
          </HelpHint>
        )}
        {micSupported && (
          <button onClick={handleMicClick} className={`shrink-0 p-1.5 border transition-colors ${listening ? 'text-black bg-[#00ff41] border-[#00ff41] animate-pulse' : 'text-[#00ff41] border-[#00ff41]/40 hover:border-[#00ff41]'}`} title="Voice input">
            {listening ? <MicOff size={16} /> : <Mic size={16} />}
          </button>
        )}
        <HelpHint id="chat-send" title="Build with Morpheus" body="Tell Morpheus what to build or change. He plans the architecture, writes production-ready code, and reviews it before saving. Attach reference files with the paperclip, or use voice input with the mic. Press Enter to send.">
          <button onClick={handleSend} disabled={loading || (!hasText && attachments.length === 0)} className="text-[#00ff41] hover:text-black hover:bg-[#00ff41] px-3 py-1 border border-[#00ff41]/40 disabled:opacity-30 transition-colors">
            <Send size={16} />
          </button>
        </HelpHint>
      </div>
    </div>
  );
}