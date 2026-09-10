import { useState, useEffect, useCallback } from 'react';
import { X, Rocket, Loader2, Check, AlertTriangle, GitBranch, ShieldCheck, ShieldAlert, FileDiff } from 'lucide-react';
import { base44 } from '@/api/base44Client';

// DEPLOY panel (2026-09-10) — ship this project's code to its connected
// WordPress site through the `wordpress` delivery adapter. Slice 1 is
// read-only: live-site health, the plugin's armed state, and a dry-run diff
// (what a deploy would change — nothing is written). The armed ship +
// auto-merge path lands once there's a staging site to prove rollback on.
//
// The WordPress connection is shared with the STORE panel (one
// PluginConnection per project) — connect there first.

const inputNote = 'text-[11px] text-primary/45 leading-relaxed';

function HealthRow({ c }) {
  return (
    <div className="flex items-start gap-2 text-[11px] py-1">
      {c.ok
        ? <Check size={13} className="text-primary mt-0.5 shrink-0" />
        : <AlertTriangle size={13} className="text-red-400 mt-0.5 shrink-0" />}
      <div className="min-w-0">
        <span className={c.ok ? 'text-primary/80' : 'text-red-400'}>{c.name}</span>
        {c.detail && <span className="text-primary/35"> — {c.detail}</span>}
      </div>
    </div>
  );
}

export default function DeployPanel({ open, onClose, projectId }) {
  const [state, setState] = useState(null); // status result | { connected:false }
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  const [verify, setVerify] = useState(null);
  const [verifying, setVerifying] = useState(false);
  const [diff, setDiff] = useState(null);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true); setErr(null);
    try {
      const { data } = await base44.functions.invoke('wordPressDeploy', { projectId, action: 'status' });
      setState(data);
    } catch (e) {
      // resolveWordpressDelivery throws a friendly 400 when no connection /
      // repo / GitHub — surface it as the "not ready" state, not an error.
      const msg = e?.data?.error || e.message;
      if (e?.data?.status === 400 || /connect|repo|GitHub/i.test(msg)) {
        setState({ connected: false, reason: msg });
      } else {
        setErr(msg);
      }
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (open) { setVerify(null); setDiff(null); setErr(null); load(); }
  }, [open, load]);

  if (!open) return null;

  const runVerify = async () => {
    setVerifying(true); setErr(null); setVerify(null);
    try {
      const { data } = await base44.functions.invoke('wordPressDeploy', { projectId, action: 'verify' });
      setVerify(data);
    } catch (e) { setErr(e?.data?.error || e.message); }
    finally { setVerifying(false); }
  };

  const runDryRun = async () => {
    setRunning(true); setErr(null); setDiff(null);
    try {
      const { data } = await base44.functions.invoke('wordPressDeploy', { projectId, action: 'dry_run' });
      setDiff(data);
    } catch (e) { setErr(e?.data?.error || e.message); }
    finally { setRunning(false); }
  };

  const ready = state?.connected;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/80" onClick={onClose}>
      <div className="bg-background border-l border-primary/40 w-full max-w-md h-full flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-primary/20 shrink-0">
          <div className="flex items-center gap-2">
            <Rocket size={16} className="text-primary" />
            <span className="text-primary font-display tracking-wider text-sm">DEPLOY</span>
          </div>
          <button onClick={onClose} className="text-primary/60 hover:text-primary p-1"><X size={18} /></button>
        </div>

        <p className={`${inputNote} px-4 py-2 border-b border-primary/10 shrink-0`}>
          Ship this project’s code to its connected WordPress site. Morpheus opens a PR on your repo; once CI is green and it merges, the plugin writes the change to the live server and health-checks it.
        </p>

        {err && <div className="m-4 mb-0 text-red-400 text-[11px] border border-red-500/30 px-3 py-2">{err}</div>}

        {loading && (
          <div className="p-4 flex items-center gap-2 text-primary/60 text-xs"><Loader2 size={14} className="animate-spin" /> Loading…</div>
        )}

        {!loading && !ready && (
          <div className="p-4 text-[12px] text-primary/55 leading-relaxed">
            {state?.reason || 'Connect this project to a WordPress site in the STORE panel first.'}
          </div>
        )}

        {!loading && ready && (
          <div className="flex-1 overflow-y-auto scrollbar-matrix p-4 space-y-5">
            {/* connection */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5 text-[10px] text-primary/40 uppercase tracking-wider">
                <GitBranch size={11} /> Target
              </div>
              <div className="text-[12px] text-primary/80 font-mono break-all">{state.repo} · {state.branch}</div>
              <div className="text-[11px] text-primary/45 break-all">{state.siteUrl?.replace(/^https?:\/\//, '')}</div>
              {state.plugin && (
                <div className={`inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wide px-2 py-1 border mt-1 ${state.plugin.armed ? 'text-yellow-500/90 border-yellow-500/40' : 'text-primary/60 border-primary/30'}`}>
                  {state.plugin.armed ? <ShieldAlert size={11} /> : <ShieldCheck size={11} />}
                  plugin {state.plugin.armed ? 'ARMED — writes files' : 'not armed — dry-run'} · v{state.plugin.version}
                </div>
              )}
            </div>

            {/* live-site health */}
            {state.health && (
              <div className="space-y-1">
                <div className="text-[10px] text-primary/40 uppercase tracking-wider mb-1">Live-site health</div>
                {(state.health.checks || []).map((c, i) => <HealthRow key={i} c={c} />)}
                {(!state.health.checks || state.health.checks.length === 0) && (
                  <div className="text-[11px] text-primary/40">{state.health.detail || 'no checks'}</div>
                )}
              </div>
            )}

            {/* verify */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-primary/40 uppercase tracking-wider">Syntax check</span>
                <button onClick={runVerify} disabled={verifying}
                  className="text-[11px] px-3 py-1.5 border border-primary/40 text-primary/80 hover:border-primary hover:text-primary disabled:opacity-40">
                  {verifying ? <Loader2 size={11} className="animate-spin inline" /> : 'VERIFY'}
                </button>
              </div>
              {verify && (
                verify.ok
                  ? <div className="text-[11px] text-primary/70 flex items-center gap-1.5"><Check size={12} /> {verify.checkedFiles} script file{verify.checkedFiles === 1 ? '' : 's'} clean</div>
                  : <div className="space-y-1">
                      {verify.errors.map((e, i) => (
                        <div key={i} className="text-[10px] text-red-400 font-mono">{e.file}:{e.line} — {e.text}</div>
                      ))}
                    </div>
              )}
            </div>

            {/* dry run */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-primary/40 uppercase tracking-wider">What would deploy</span>
                <button onClick={runDryRun} disabled={running}
                  className="flex items-center gap-1.5 text-[11px] px-3 py-1.5 border border-primary/40 text-primary/80 hover:border-primary hover:text-primary disabled:opacity-40">
                  {running ? <Loader2 size={11} className="animate-spin" /> : <FileDiff size={11} />} DRY RUN
                </button>
              </div>
              {diff && !diff.changed && (
                <div className="text-[11px] text-primary/55">Nothing to deploy — the site’s repo already matches this project.</div>
              )}
              {diff && diff.changed && (
                <div className="space-y-1.5">
                  <div className="text-[11px] text-primary/70">
                    {diff.createCount} new · {diff.updateCount} changed · {diff.deleteCount} deleted
                  </div>
                  <div className="max-h-40 overflow-y-auto scrollbar-matrix border border-primary/15 p-2 space-y-0.5">
                    {diff.changedPaths.map((p) => <div key={p} className="text-[10px] text-primary/60 font-mono">{p}</div>)}
                    {diff.deletePaths.map((p) => <div key={p} className="text-[10px] text-red-400/70 font-mono">− {p}</div>)}
                  </div>
                </div>
              )}
            </div>

            <div className="border border-primary/20 bg-primary/[0.03] px-3 py-2.5 text-[10px] text-primary/50 leading-relaxed">
              Deploys are <span className="text-primary/70">dry-run only</span> for now — Morpheus writes nothing to the live site until a staging environment is set up to prove the auto-rollback. Use chat to make changes; they land in your repo and show here.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
