import { useState } from 'react';
import { Github, Check, XCircle, Loader2, Trash2, Search } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { useGithubConnection } from '@/hooks/useGithubConnection';

// Shared GitHub OAuth connect/disconnect + build-repo cleanup block.
//
// 2026-09-08: Rob reported "my github is not connecting and i dont see a way
// for other users to connect and refresh their oauth app if it runs out."
// The connect/disconnect/reconnect flow itself was already working (verified
// live this session — disconnect, re-authorize, callback all completed
// correctly) but the ONE place it was reachable was a small "CONNECTIONS"
// tile on the workspace-picker screen, opened via ConnectionsDialog.jsx.
// Settings — the obvious place any user would look for "manage my account's
// connections" — only rendered CapabilityStatus.jsx's read-only status dot
// for GitHub ("CONNECTED" / "SETUP NEEDED"), with no button to act on it. A
// user whose token died, or who never connected in the first place, had no
// visible path forward from Settings at all.
//
// Extracted this out of what was inline JSX in ConnectionsDialog.jsx so both
// surfaces render the exact same connect/disconnect/cleanup UI from one
// component, rather than two copies that could quietly drift apart (see
// github.js's 2026-09-08 comment for what happens when two versions of the
// same logic diverge unnoticed).
export default function GithubConnectionSection() {
  const gh = useGithubConnection();

  // Build-repo cleanup ("a github cli automated interface to batch delete
  // all the old repos that get created trying to compile") — see
  // server/src/functions/cleanupBuildRepos.js. Two-step: preview lists what
  // would be deleted (dry run), delete requires that preview to have run
  // first so nothing is ever removed sight-unseen.
  const [cleanup, setCleanup] = useState({ status: 'idle', preview: null, result: null, error: null });

  const previewCleanup = async () => {
    setCleanup((c) => ({ ...c, status: 'previewing', error: null, result: null }));
    try {
      const { data } = await base44.functions.invoke('cleanupBuildRepos', { confirm: false });
      setCleanup((c) => ({ ...c, status: 'previewed', preview: data }));
    } catch (err) {
      setCleanup((c) => ({ ...c, status: 'idle', error: err?.response?.data?.error || err.message }));
    }
  };

  const runCleanup = async () => {
    setCleanup((c) => ({ ...c, status: 'deleting', error: null }));
    try {
      const { data } = await base44.functions.invoke('cleanupBuildRepos', { confirm: true });
      setCleanup((c) => ({ ...c, status: 'done', result: data, preview: null }));
    } catch (err) {
      setCleanup((c) => ({ ...c, status: 'previewed', error: err?.response?.data?.error || err.message }));
    }
  };

  return (
    <section className="border border-primary/30 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Github size={16} className={gh.connected ? 'text-primary shrink-0' : 'text-primary/50 shrink-0'} />
          <span className="text-sm text-ink">GitHub</span>
          {gh.loading ? (
            <span className="flex items-center gap-1 text-[10px] text-primary/50 border border-primary/20 px-1.5 py-0.5">
              <Loader2 size={10} className="animate-spin" /> CHECKING
            </span>
          ) : gh.connected ? (
            <span className="flex items-center gap-1 text-[10px] text-primary border border-primary/40 px-1.5 py-0.5 truncate">
              <Check size={10} /> CONNECTED{gh.login ? ` · ${gh.login}` : ''}
            </span>
          ) : (
            <span className="flex items-center gap-1 text-[10px] text-primary/50 border border-primary/20 px-1.5 py-0.5">
              <XCircle size={10} /> DISCONNECTED
            </span>
          )}
        </div>
        {gh.connected ? (
          <button onClick={gh.disconnect} className="text-xs text-red-500/80 hover:text-red-400 border border-red-500/30 px-2.5 py-1.5 min-h-[44px] shrink-0">DISCONNECT</button>
        ) : (
          <button onClick={gh.connect} className="text-xs text-black bg-primary hover:bg-[#39ff14] px-3 py-1.5 min-h-[44px] font-bold flex items-center gap-1 shrink-0">
            <Github size={12} /> CONNECT
          </button>
        )}
      </div>
      <p className="text-[10px] text-ink-max mt-2">
        // Required to compile binaries, import repos, and push to GitHub. OAuth — no token pasting. If it ever stops working (token expired or access revoked on GitHub's side), click DISCONNECT then CONNECT again here to re-authorize.
      </p>

      {gh.connected && (
        <div className="mt-3 border-t border-primary/15 pt-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-[10px] text-ink-max flex-1 min-w-[180px]">
              // Compiles used to create a fresh <code>morpheus-build-*</code> repo per attempt. That's fixed — a project now reuses one repo — so these are leftovers. Clean up the ones older than 24h.
            </p>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={previewCleanup}
                disabled={cleanup.status === 'previewing' || cleanup.status === 'deleting'}
                className="text-xs text-primary border border-primary/40 px-2.5 py-1.5 min-h-[44px] flex items-center gap-1.5 disabled:opacity-40"
              >
                {cleanup.status === 'previewing' ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
                PREVIEW
              </button>
              {cleanup.status === 'previewed' && cleanup.preview?.count > 0 && (
                <button
                  onClick={runCleanup}
                  disabled={cleanup.status === 'deleting'}
                  className="text-xs text-red-500/90 hover:text-red-400 border border-red-500/40 px-2.5 py-1.5 min-h-[44px] flex items-center gap-1.5 disabled:opacity-40"
                >
                  {cleanup.status === 'deleting' ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                  DELETE {cleanup.preview.count}
                </button>
              )}
            </div>
          </div>

          {cleanup.error && <p className="text-[10px] text-red-400 mt-2">// {cleanup.error}</p>}

          {cleanup.status === 'previewed' && cleanup.preview && (
            <p className="text-[10px] text-ink-max mt-2">
              {cleanup.preview.count === 0
                ? 'Nothing to clean up — no build repos older than 24h.'
                : `Found ${cleanup.preview.count} build repo${cleanup.preview.count === 1 ? '' : 's'} older than ${cleanup.preview.olderThanHours}h, ready to delete.`}
            </p>
          )}

          {cleanup.status === 'done' && cleanup.result && (
            <p className="text-[10px] mt-2 text-ink-max">
              Deleted {cleanup.result.deletedCount}/{cleanup.result.attempted}.
              {cleanup.result.failed?.length > 0 && ` ${cleanup.result.failed.length} failed.`}
              {cleanup.result.hint && <span className="text-red-400/90 block mt-1">// {cleanup.result.hint}</span>}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
