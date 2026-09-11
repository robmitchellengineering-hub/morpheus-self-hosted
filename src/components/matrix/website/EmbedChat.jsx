import { useState, useRef, useEffect, useCallback } from 'react';
import { Loader2, Send, Sparkles } from 'lucide-react';
import { base44 } from '@/api/base44Client';

// CHAT tab of the embeddable widget. Talks to chatWithMorpheus in CONTEXT
// mode only — discuss the site, ask questions, sketch a plan. It never
// writes code or spends a build: to actually build, the operator opens the
// full Morpheus workspace. Server-side the turn is still saved to the
// project's history, so the conversation carries over to the workspace.

export default function EmbedChat({ projectId, projectName }) {
  const [messages, setMessages] = useState([]); // [{ role: 'user' | 'morpheus', content }]
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [stage, setStage] = useState(null);
  const [err, setErr] = useState(null);
  const scrollRef = useRef(null);

  const scrollToEnd = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => { scrollToEnd(); }, [messages, stage, scrollToEnd]);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput(''); setErr(null); setSending(true); setStage(null);
    setMessages((m) => [...m, { role: 'user', content: text }]);
    try {
      const { data } = await base44.functions.invokeStream(
        'chatWithMorpheus',
        { projectId, message: text, mode: 'context', webAccess: false },
        (evt) => { if (evt.status === 'start') setStage(evt.label || 'Working'); },
      );
      setMessages((m) => [...m, { role: 'morpheus', content: data?.reply || '…' }]);
    } catch (e) {
      setErr(e?.data?.error || e.message || 'Morpheus could not reply.');
    } finally {
      setSending(false); setStage(null);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  return (
    <div className="flex flex-col h-[440px]">
      <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-matrix p-4 space-y-3">
        {messages.length === 0 && !sending && (
          <div className="text-[12px] text-primary/55 leading-relaxed">
            <div className="flex items-center gap-1.5 text-primary/80 mb-1"><Sparkles size={13} /> Ask Morpheus about {projectName || 'your site'}</div>
            Questions, ideas, a plan for a change — this is a discussion. Nothing here changes the
            site. When you’re ready to build, open the full Morpheus workspace.
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={m.role === 'user' ? 'text-right' : ''}>
            <div className={`inline-block max-w-[85%] text-left px-3 py-2 text-[12px] leading-relaxed whitespace-pre-wrap break-words border ${
              m.role === 'user'
                ? 'border-primary/30 bg-primary/5 text-primary/90'
                : 'border-primary/15 text-primary/80'
            }`}>
              {m.content}
            </div>
          </div>
        ))}

        {sending && (
          <div className="flex items-center gap-2 text-[11px] text-primary/50">
            <Loader2 size={12} className="animate-spin" /> {stage || 'Morpheus is thinking'}…
          </div>
        )}
      </div>

      {err && <div className="mx-4 mb-2 text-red-400 text-[11px] border border-red-500/30 px-3 py-2">{err}</div>}

      <div className="p-3 border-t border-primary/20 shrink-0 flex items-end gap-2">
        <textarea
          className="flex-1 bg-black/30 border border-primary/20 px-2.5 py-2 text-[13px] text-primary focus:outline-none focus:border-primary/50 resize-none"
          rows={2}
          placeholder="Ask about your site…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={sending}
        />
        <button
          onClick={send}
          disabled={sending || !input.trim()}
          className="shrink-0 h-[44px] w-[44px] flex items-center justify-center bg-primary text-black hover:bg-[#39ff14] disabled:opacity-40 transition-colors">
          {sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
        </button>
      </div>
    </div>
  );
}
