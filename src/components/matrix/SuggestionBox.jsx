import { useState } from 'react';
import { Lightbulb, ChevronDown, ChevronUp, Loader2, Check } from 'lucide-react';
import { base44 } from '@/api/base44Client';

// New — not a base44 port. Mirrors base44's live "SUGGEST AN IMPROVEMENT"
// public feedback box on the landing page, which prior audits missed for
// the same reason DonateWidget was missed: they only ever covered the
// logged-in /workspace app. Collapsed by default, same as base44's version.
// Backed by server/src/functions/submitFeedback.js — no login required.
const TABS = [
  { id: 'feature', label: 'FEATURE' },
  { id: 'bug', label: 'BUG' },
];

export default function SuggestionBox() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('feature');
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [submitted, setSubmitted] = useState(false);

  const submit = async () => {
    if (!message.trim()) {
      setError('Say a bit more before you send it.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await base44.functions.invoke('submitFeedback', { type: tab, message: message.trim(), email: email.trim() || undefined });
      setSubmitted(true);
      setMessage('');
      setEmail('');
    } catch (e) {
      setError(e.message || 'Could not send feedback');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mt-4 mx-auto max-w-lg text-left border border-primary/30">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-4 py-3 text-primary/80 hover:text-primary transition-colors"
      >
        <span className="flex items-center gap-2 text-xs font-display tracking-[0.15em]">
          <Lightbulb size={14} /> // SUGGEST AN IMPROVEMENT
        </span>
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>

      {open && (
        <div className="px-4 pb-4 border-t border-primary/20 pt-3">
          {submitted ? (
            <p className="text-xs text-ink/80 flex items-center gap-2 py-2">
              <Check size={14} /> Got it — thanks for helping shape Morpheus.
            </p>
          ) : (
            <>
              <p className="text-xs text-ink/60 mb-3 leading-relaxed">
                Found a bug? Got an idea to make Morpheus better? Drop it here.
              </p>

              <div className="flex gap-2 mb-3">
                {TABS.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setTab(t.id)}
                    className={`px-3 py-1.5 text-[10px] font-display tracking-wider border transition-colors ${
                      tab === t.id ? 'border-primary bg-primary/5 text-primary' : 'border-primary/20 text-primary/50 hover:border-primary/50'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={tab === 'bug' ? "What went wrong, and what did you expect instead?" : 'What should Morpheus do?'}
                rows={3}
                className="w-full bg-black/40 border border-primary/30 text-ink text-xs p-2.5 outline-none focus:border-primary/60 placeholder:text-ink/30 resize-none"
              />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email (optional — if you want a reply)"
                className="w-full mt-2 bg-black/40 border border-primary/30 text-ink text-xs p-2.5 outline-none focus:border-primary/60 placeholder:text-ink/30"
              />

              {error && <p className="text-red-400 text-xs mt-3">// {error}</p>}

              <button
                onClick={submit}
                disabled={loading}
                className="w-full mt-3 flex items-center justify-center gap-2 text-sm text-black bg-primary hover:bg-[#39ff14] px-4 py-2.5 disabled:opacity-40 font-bold tracking-wider"
              >
                {loading ? <Loader2 size={14} className="animate-spin" /> : <Lightbulb size={14} />} SEND
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
