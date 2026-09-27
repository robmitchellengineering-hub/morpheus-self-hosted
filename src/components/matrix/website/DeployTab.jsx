import { useState, useEffect, useCallback, useRef } from 'react';
import { Rocket, Loader2, Check, AlertTriangle, GitBranch, ShieldCheck, ShieldAlert, FileDiff, ExternalLink, GitPullRequest } from 'lucide-react';
import { base44 } from '@/api/base44Client';

// DEPLOY tab of the WEBSITE panel — ship this project's code to the
// connected WordPress site through the `wordpress` delivery adapter.
//   SHIP → verify → PR on the repo → auto-merge on green → plugin pulls
//   the change onto the live server (only writes if "Armed" in the plugin).

function HealthRow({ c }) {
  return (
    <div className="flex items-start gap-2 text-[11px] py-1">
      {c.ok ? <Check size={13} className="text-primary mt-0.5 shrink-0" /> : <AlertTriangle size={13} className="text-red-400 mt-0.5 shrink-0" />}
      <div className="min-w-0">
        <span className={c.ok ? 'text-ink-max' : 'text-red-400'}>{c.name}</span>
        {c.detail && <span className="text-ink-max"> — {c.detail}</span>}
      </div>
    </div>
  );
}

export default function DeployTab({ projectId }) {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  const [verify, setVerify] = useState(null);
  const [verifying, setVerifying] = useState(false);
  const [diff, setDiff] = useState(null);
  const [running, setRunning] = useState(false);

  const [ship, setShip] = useState(null);
  const [shipping, setShipping] = useState(false);
  const [merge, setMerge] = useState(null);
  const pollRef = useRef(null);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true); setErr(null);
    try {
      const { data } = await base44.functions.invoke('wordPressDeploy', { projectId, action: 'status' });
      setState(data);
    } catch (e) {
      const msg = e?.data?.error || e.message;
      if (e?.data?.status === 400 || /connect|repo|GitHub/i.test(msg)) setState({ notReady: true, reason: msg });
      else setErr(msg);
    } finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { setVerify(null); setDiff(null); setShip(null); setMerge(null); load(); }, [load]);
  useEffect(() => () => { if (pollRef.current) clearTimeout(pollRef.current); }, []);

  useEffect(() => {
    const prNumber = ship?.shipped ? ship.prNumber : null;
    if (!prNumber || merge?.phase === 'merged' || merge?.phase === 'failed') return;
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      try {
        const { data } = await base44.functions.invoke('wordPressDeploy', { projectId, action: 'merge', prNumber });
        if (cancelled) return;
        if (data.merged) { setMerge({ phase: 'merged', result: data }); load(); return; }
        if (['failed', 'conflict', 'merge_failed'].includes(data.state)) { setMerge({ phase: 'failed', result: data }); return; }
        setMerge({ phase: 'polling', result: data });
        pollRef.current = setTimeout(poll, 15000);
      } catch {
        if (!cancelled) pollRef.current = setTimeout(poll, 20000);
      }
    };
    pollRef.current = setTimeout(poll, 8000);
    return () => { cancelled = true; if (pollRef.current) clearTimeout(pollRef.current); };
  }, [ship?.prNumber, merge?.phase, projectId, load]);

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
  const runShip = async () => {
    setShipping(true); setErr(null); setShip(null); setMerge(null);
    try {
      const { data } = await base44.functions.invoke('wordPressDeploy', { projectId, action: 'ship' });
      setShip(data);
      if (data.blocked) setErr('Syntax check failed — fix the code (in chat) and try again.');
    } catch (e) { setErr(e?.data?.error || e.message); }
    finally { setShipping(false); }
  };

  const busy = shipping || merge?.phase === 'polling';

  if (loading) return <div className="p-4 flex items-center gap-2 text-ink-strong text-xs"><Loader2 size={14} className="animate-spin" /> Loading…</div>;

  if (state?.notReady) {
    return (
      <div className="p-4 text-[12px] text-ink-strong leading-relaxed">
        {state.reason || 'Finish Setup first, then point the plugin at your repo.'}
        <div className="text-[10px] text-ink-max mt-2 leading-relaxed">
          The Deploy tab needs: (1) this project connected to a GitHub repo (Share → Export to GitHub), and (2) the plugin’s repo + a GitHub token set in Settings → Morpheus.
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-5">
      {err && <div className="text-red-400 text-[11px] border border-red-500/30 px-3 py-2">{err}</div>}

      {state && (
        <>
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-[10px] text-primary/40 uppercase tracking-wider"><GitBranch size={11} /> Target</div>
            <div className="text-[12px] text-ink-strong font-mono break-all">{state.repo} · {state.branch}</div>
            <div className="text-[11px] text-ink-max break-all">{state.siteUrl?.replace(/^https?:\/\//, '')}</div>
            {state.plugin && (
              <div className={`inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wide px-2 py-1 border mt-1 ${state.plugin.armed ? 'text-yellow-500/90 border-yellow-500/40' : 'text-primary/60 border-primary/30'}`}>
                {state.plugin.armed ? <ShieldAlert size={11} /> : <ShieldCheck size={11} />}
                plugin {state.plugin.armed ? 'ARMED — writes to live site' : 'not armed — deploy is a dry-run'} · v{state.plugin.version}
              </div>
            )}
            {state.plugin && !state.plugin.configured && (
              <div className="text-[10px] text-ink-max">Deploy module not configured on the plugin yet — set the repo + a GitHub token in Settings → Morpheus for it to write files.</div>
            )}
          </div>

          {state.health && (
            <div className="space-y-1">
              <div className="text-[10px] text-primary/40 uppercase tracking-wider mb-1">Live-site health</div>
              {(state.health.checks || []).map((c, i) => <HealthRow key={i} c={c} />)}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <button onClick={runVerify} disabled={verifying || busy}
              className="text-[11px] px-3 py-2 border border-primary/40 text-primary/80 hover:border-primary hover:text-primary disabled:opacity-40">
              {verifying ? <Loader2 size={11} className="animate-spin inline" /> : 'VERIFY'}
            </button>
            <button onClick={runDryRun} disabled={running || busy}
              className="flex items-center justify-center gap-1.5 text-[11px] px-3 py-2 border border-primary/40 text-primary/80 hover:border-primary hover:text-primary disabled:opacity-40">
              {running ? <Loader2 size={11} className="animate-spin" /> : <FileDiff size={11} />} DRY RUN
            </button>
          </div>

          {/* Three states, not two. A change with no JS/TS (a PHP-only theme edit,
              the normal case here) is NOT verified by this check and must not
              render as "0 script files clean" — see engine/verificationCoverage.js. */}
          {verify && (verify.status === 'failed'
            ? <div className="space-y-1">{verify.errors.map((e, i) => <div key={i} className="text-[10px] text-red-400 font-mono">{e.file}:{e.line} — {e.text}</div>)}</div>
            : verify.status === 'not_verified'
              ? <div className="text-[11px] text-ink-max flex items-start gap-1.5"><AlertTriangle size={12} className="text-yellow-500/90 mt-0.5 shrink-0" /><span>{verify.coverage?.text} PHP lint runs in the target repo’s CI.</span></div>
              : <div className="text-[11px] text-ink-max flex items-center gap-1.5"><Check size={12} /> {verify.checkedFiles} script file{verify.checkedFiles === 1 ? '' : 's'} clean</div>
          )}

          {diff && !diff.changed && <div className="text-[11px] text-ink-max">Nothing to deploy — the site’s repo already matches this project.</div>}
          {diff && diff.changed && (
            <div className="space-y-1.5">
              <div className="text-[11px] text-ink-max">{diff.createCount} new · {diff.updateCount} changed · {diff.deleteCount} deleted</div>
              <div className="max-h-40 overflow-y-auto scrollbar-matrix border border-primary/15 p-2 space-y-0.5">
                {diff.changedPaths.map((p) => <div key={p} className="text-[10px] text-ink-max font-mono">{p}</div>)}
                {diff.deletePaths.map((p) => <div key={p} className="text-[10px] text-red-400/70 font-mono">− {p}</div>)}
              </div>
            </div>
          )}

          <div className="border-t border-primary/15 pt-4 space-y-2">
            <button onClick={runShip} disabled={busy}
              className="w-full flex items-center justify-center gap-2 h-[44px] bg-primary text-black font-bold text-[13px] hover:bg-[#39ff14] disabled:opacity-40 transition-colors">
              {shipping ? <Loader2 size={14} className="animate-spin" /> : <Rocket size={14} />}
              {shipping ? 'SHIPPING…' : 'SHIP TO SITE'}
            </button>

            {ship?.shipped === false && ship.reason === 'no-changes' && (
              <div className="text-[11px] text-ink-max">Nothing to ship — the repo already matches this project.</div>
            )}
            {ship?.blocked && <div className="text-[11px] text-red-400">Syntax check failed — nothing was pushed. Fix it in chat and ship again.</div>}

            {ship?.shipped && (
              <div className="border border-primary/25 px-3 py-2.5 space-y-2 text-[11px]">
                <a href={ship.prUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-primary/80 hover:text-primary">
                  <GitPullRequest size={12} /> PR #{ship.prNumber} — {ship.summary} <ExternalLink size={10} />
                </a>
                {(!merge || merge.phase === 'polling') && (
                  <div className="flex items-center gap-1.5 text-ink-max">
                    <Loader2 size={11} className="animate-spin" /> {merge?.result?.note || 'Waiting for checks, then merging…'}
                  </div>
                )}
                {merge?.phase === 'failed' && (
                  <div className="text-red-400">{merge.result.message || `Checks failed (${(merge.result.failing || []).join(', ') || 'see the PR'}). Base branch untouched.`}</div>
                )}
                {merge?.phase === 'merged' && (
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-1.5 text-ink-max"><Check size={12} /> Merged.</div>
                    {merge.result.deploy && (
                      <div className="text-ink-max">
                        {merge.result.deploy.triggered
                          ? (state.plugin?.armed ? 'Plugin deployed the change to the live site.' : 'Plugin acknowledged (not armed — reported the diff, wrote nothing).')
                          : `Deploy webhook not fired: ${merge.result.deploy.reason || merge.result.deploy.error || 'unknown'}`}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="border border-primary/20 bg-primary/[0.03] px-3 py-2.5 text-[10px] text-ink-max leading-relaxed">
            To make changes, use <span className="text-ink-max">chat</span> in this project — they land in the file tree, then ship here. The plugin only writes to the live server when <span className="text-ink-max">Armed</span> in Settings → Morpheus.
          </div>
        </>
      )}
    </div>
  );
}
