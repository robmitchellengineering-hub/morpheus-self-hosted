import { useGithubConnection } from '@/hooks/useGithubConnection';
import { Github, Loader2, Unlink, ExternalLink, KeyRound, AppWindow } from 'lucide-react';
import HelpHint from './HelpHint';

// Wraps GitHub-dependent UI. Shows a Connect button if the user hasn't linked
// their GitHub account yet, and only renders children once connected.
export default function GithubGate({ children, note }) {
  const { connected, login, loading, connect, disconnect } = useGithubConnection();

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 text-[#00ff41]/50 text-sm py-4">
        <Loader2 size={16} className="animate-spin" /> Checking GitHub link...
      </div>
    );
  }

  if (!connected) {
    return (
      <div className="space-y-3">
        <p className="text-xs text-[#00ff41]/50">
          // {note || 'Connect your GitHub account to continue. Morpheus pushes to your own repos using your free Actions minutes.'}
        </p>
        <HelpHint id="github-connect" title="Connect Your GitHub" body="Connect your GitHub account so Morpheus can push code and compile binaries using your free GitHub Actions minutes. This is a 2-step setup:\n\n1. Register an OAuth app on GitHub (link below) to get your client ID + secret.\n2. Generate a personal access token (link below).\n\nThen click CONNECT GITHUB and authorize.">
          <button onClick={connect} className="w-full flex items-center justify-center gap-2 py-2.5 border border-[#00ff41] text-[#00ff41] hover:bg-[#00ff41] hover:text-black transition-colors font-bold text-sm tracking-wider">
            <Github size={16} /> CONNECT GITHUB
          </button>
        </HelpHint>
        <div className="pt-2 border-t border-[#00ff41]/15 space-y-1.5">
          <p className="text-[10px] text-[#00ff41]/75 uppercase tracking-wider">Setup help — 2 steps</p>
          <a href="https://github.com/settings/applications/new" target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-xs text-[#00ff41]/60 hover:text-[#00ff41] transition-colors">
            <AppWindow size={11} className="shrink-0" /> Step 1: Register OAuth app (client ID + secret)
            <ExternalLink size={10} className="shrink-0 ml-auto" />
          </a>
          <a href="https://github.com/settings/tokens" target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-xs text-[#00ff41]/60 hover:text-[#00ff41] transition-colors">
            <KeyRound size={11} className="shrink-0" /> Step 2: Generate auth token
            <ExternalLink size={10} className="shrink-0 ml-auto" />
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs">
        <span className="text-[#00ff41]/60 flex items-center gap-1.5">
          <Github size={12} /> {login}
        </span>
        <button onClick={disconnect} className="text-[#00ff41]/75 hover:text-red-400 flex items-center gap-1">
          <Unlink size={12} /> Disconnect
        </button>
      </div>
      {children}
    </div>
  );
}