import { useState } from 'react';
import { Github, X, Loader2, Copy, Check, ExternalLink, AlertTriangle } from 'lucide-react';

// Rendered once, by GithubConnectionProvider. Driven entirely by the
// `device` state object from that context:
//   phase 'starting'   — requesting a code from GitHub
//   phase 'awaiting'    — code issued, waiting for the user to approve it
//   phase 'error'       — code expired / declined / start failed
// Any other phase ('idle') renders nothing.
export default function GithubDeviceModal({ device, onCancel, onRetry }) {
  const [copied, setCopied] = useState(false);
  const { phase, userCode, verificationUri, error } = device || {};

  if (phase !== 'starting' && phase !== 'awaiting' && phase !== 'error') return null;

  const copyCode = async () => {
    if (!userCode) return;
    try {
      await navigator.clipboard.writeText(userCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked — the code is on screen to type */ }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 p-4">
      <div className="w-full max-w-md border border-primary/40 bg-background p-6 neon-border">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-primary font-display tracking-wider flex items-center gap-2">
            <Github size={18} /> CONNECT GITHUB
          </h2>
          <button onClick={onCancel} className="text-primary/50 hover:text-primary" aria-label="Close"><X size={18} /></button>
        </div>

        {phase === 'starting' && (
          <div className="flex items-center justify-center gap-2 text-primary/60 text-sm py-8">
            <Loader2 size={16} className="animate-spin" /> Requesting a sign-in code...
          </div>
        )}

        {phase === 'error' && (
          <div className="space-y-4">
            <div className="flex items-start gap-2 text-sm text-red-400">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <p>// {error || 'GitHub connection failed'}</p>
            </div>
            <button
              onClick={onRetry}
              className="w-full py-2 border border-primary text-primary hover:bg-primary hover:text-black transition-colors font-bold text-sm tracking-wider"
            >
              TRY AGAIN
            </button>
          </div>
        )}

        {phase === 'awaiting' && (
          <div className="space-y-4">
            <ol className="text-xs text-primary/60 space-y-1 list-decimal list-inside">
              <li>Open GitHub (opens in a new tab)</li>
              <li>Enter this code and authorize Morpheus</li>
              <li>Come back here — this closes itself once you're connected</li>
            </ol>

            <div>
              <label className="block text-[10px] text-primary/50 uppercase tracking-wider mb-1">Your code</label>
              <button
                onClick={copyCode}
                className="w-full flex items-center justify-center gap-3 border border-primary/40 bg-primary/5 py-3 hover:bg-primary/10 transition-colors"
                title="Copy code"
              >
                <span className="font-mono text-2xl tracking-[0.3em] text-primary">{userCode || '········'}</span>
                {copied ? <Check size={16} className="text-primary" /> : <Copy size={14} className="text-primary/50" />}
              </button>
            </div>

            <a
              href={verificationUri || 'https://github.com/login/device'}
              target="_blank"
              rel="noreferrer"
              className="w-full flex items-center justify-center gap-2 py-2.5 border border-primary text-primary hover:bg-primary hover:text-black transition-colors font-bold text-sm tracking-wider"
            >
              <ExternalLink size={14} /> OPEN GITHUB
            </a>

            <div className="flex items-center justify-center gap-2 text-primary/50 text-xs pt-1">
              <Loader2 size={13} className="animate-spin" /> Waiting for authorization...
            </div>

            <button onClick={onCancel} className="w-full text-xs text-primary/50 hover:text-primary/80 pt-1">
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
