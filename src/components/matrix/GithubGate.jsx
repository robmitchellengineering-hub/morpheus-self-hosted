import { useGithubConnection } from '@/hooks/useGithubConnection';
import { Github, Loader2, Unlink } from 'lucide-react';
import HelpHint from './HelpHint';

// Wraps GitHub-dependent UI. Shows a Connect button if the user hasn't linked
// their GitHub account yet, and only renders children once connected.
export default function GithubGate({ children, note, showSignup = false }) {
  const { connected, login, loading, connect, disconnect } = useGithubConnection();

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 text-primary/50 text-sm py-4">
        <Loader2 size={16} className="animate-spin" /> Checking GitHub link...
      </div>
    );
  }

  if (!connected) {
    return (
      <div className="space-y-3">
        <p className="text-xs text-primary/50">
          // {note || 'Connect your GitHub account to continue. Morpheus pushes to your own repos using your free Actions minutes.'}
        </p>
        <HelpHint id="github-connect" title="Connect Your GitHub" body="Connect your GitHub account so Morpheus can push code and compile binaries using your free GitHub Actions minutes.\n\nClick CONNECT GITHUB. A short code appears — enter it at github.com/login/device in the tab that opens, authorize Morpheus, and you're done. No OAuth app to register, no token to paste.">
          <button onClick={connect} className="w-full flex items-center justify-center gap-2 py-2.5 border border-primary text-primary hover:bg-primary hover:text-black transition-colors font-bold text-sm tracking-wider">
            <Github size={16} /> CONNECT GITHUB
          </button>
        </HelpHint>
        <p className="text-[10px] text-primary/50 pt-2 border-t border-primary/15">
          // A code appears — enter it at github.com/login/device to authorize. Nothing to install or paste.
        </p>
        {showSignup && (
          <p className="text-[10px] text-primary/45 leading-relaxed">
            No GitHub account yet?{' '}
            <a href="https://github.com/signup" target="_blank" rel="noreferrer"
              className="text-primary/75 hover:text-primary underline underline-offset-2">
              Create one free
            </a>{' '}
            — it takes a minute, then come back to this screen and tap CONNECT GITHUB. Your code lives in your own account;
            Morpheus never holds it.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs">
        <span className="text-primary/60 flex items-center gap-1.5">
          <Github size={12} /> {login}
        </span>
        <button onClick={disconnect} className="text-primary/75 hover:text-red-400 flex items-center gap-1">
          <Unlink size={12} /> Disconnect
        </button>
      </div>
      {children}
    </div>
  );
}