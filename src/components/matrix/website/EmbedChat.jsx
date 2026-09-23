import { useState, useRef, useEffect, useCallback } from 'react';
import { Loader2, Send, Sparkles, Hammer, MessagesSquare, Rocket, FileDiff, Check, GitPullRequest, ExternalLink, AlertTriangle, X } from 'lucide-react';
import { base44 } from '@/api/base44Client';

// CHAT tab of the embeddable widget.
//
//   DISCUSS mode — chatWithMorpheus in CONTEXT mode. Ask questions, sketch a
//   plan. Nothing is written, no build is spent. When the operator clearly
//   asks to trash/publish/unpublish/restock the item on the current page,
//   the reply carries a proposedAction — built server-side from the page's
//   already-verified resolve_url match, never from anything the model
//   output directly — and shows as a confirm card right under the message.
//   Nothing runs until the operator taps Confirm.
//
//   BUILD mode — the real planner/coder/reviewer pipeline, same as the full
//   workspace, grounded on whatever page the dock is open over (see
//   pageUrl/pageTitle). A turn that changes files surfaces a DRY RUN / SHIP
//   TO SITE bar right here — the same wordPressDeploy calls DeployTab makes
//   — so an edit made from the dock can go live without switching tabs. The
//   ship bar only appears when the token actually carries the `deploy`
//   scope; otherwise the operator sees the change lives in the project and
//   can ship it from the full DEPLOY tab.

export default function EmbedChat({ projectId, projectName, pageUrl, pageTitle, scopes }) {
  const [mode, setMode] = useState('context'); // 'context' | 'build'
  const [messages, setMessages] = useState([]); // [{ role, content, build? }]
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [stage, setStage] = useState(null);
  const [err, setErr] = useState(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const scrollRef = useRef(null);

  const canShip = (scopes || []).includes('deploy');
  const canStore = (scopes || []).includes('store');

  // The most recent build turn that changed files — its own little
  // dry-run/ship/merge state, same shape DeployTab.jsx keeps.
  const [lastBuild, setLastBuild] = useState(null); // { paths }
  const [diff, setDiff] = useState(null);
  const [running, setRunning] = useState(false);
  const [ship, setShip] = useState(null);
  const [shipping, setShipping] = useState(false);
  const [merge, setMerge] = useState(null);
  const pollRef = useRef(null);

  const scrollToEnd = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => { scrollToEnd(); }, [messages, stage, diff, ship, merge, scrollToEnd]);
  useEffect(() => () => { if (pollRef.current) clearTimeout(pollRef.current); }, []);

  // The transcript otherwise resets on every page load — a full navigation
  // destroys and rebuilds the iframe, but chatWithMorpheus.js already saves
  // every turn and re-loads it as model context regardless, so the AI's own
  // memory of the conversation was never actually gone. This just shows it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await base44.functions.invoke('getChatHistory', { projectId, limit: 20 });
        if (cancelled) return;
        const rows = (data?.messages || [])
          .filter((m) => m.role === 'user' || m.role === 'morpheus')
          .map((m) => ({ role: m.role, content: m.content }));
        if (rows.length) setMessages(rows);
      } catch { /* best-effort — the widget still works, just starts blank */ }
      finally { if (!cancelled) setHistoryLoaded(true); }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  // Poll the PR through to merge, exactly like DeployTab.
  useEffect(() => {
    const prNumber = ship?.shipped ? ship.prNumber : null;
    if (!prNumber || merge?.phase === 'merged' || merge?.phase === 'failed') return;
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      try {
        const { data } = await base44.functions.invoke('wordPressDeploy', { projectId, action: 'merge', prNumber });
        if (cancelled) return;
        if (data.merged) { setMerge({ phase: 'merged', result: data }); return; }
        if (['failed', 'conflict', 'merge_failed'].includes(data.state)) { setMerge({ phase: 'failed', result: data }); return; }
        setMerge({ phase: 'polling', result: data });
        pollRef.current = setTimeout(poll, 15000);
      } catch {
        if (!cancelled) pollRef.current = setTimeout(poll, 20000);
      }
    };
    pollRef.current = setTimeout(poll, 8000);
    return () => { cancelled = true; if (pollRef.current) clearTimeout(pollRef.current); };
  }, [ship?.prNumber, merge?.phase, projectId]);

  const clearBuildBar = () => { setLastBuild(null); setDiff(null); setShip(null); setMerge(null); };

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput(''); setErr(null); setSending(true); setStage(null);
    if (mode === 'build') clearBuildBar();
    setMessages((m) => [...m, { role: 'user', content: text }]);
    try {
      const { data } = await base44.functions.invokeStream(
        'chatWithMorpheus',
        { projectId, message: text, mode, webAccess: false, pageUrl: pageUrl || undefined, pageTitle: pageTitle || undefined },
        (evt) => { if (evt.status === 'start') setStage(evt.label || 'Working'); },
      );
      setMessages((m) => [...m, { role: 'morpheus', content: data?.reply || '…', proposedAction: data?.proposedAction || null, proposedBulkAction: data?.proposedBulkAction || null }]);
      const changed = (data?.fileOperations || []).filter((op) => op.action !== 'skipped_fake_binary');
      if (mode === 'build' && changed.length) {
        setLastBuild({ paths: changed.map((op) => op.path) });
      }
    } catch (e) {
      setErr(e?.data?.error || e.message || 'Morpheus could not reply.');
    } finally {
      setSending(false); setStage(null);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
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
      if (data.blocked) setErr('Syntax check failed — fix it and ask again.');
    } catch (e) { setErr(e?.data?.error || e.message); }
    finally { setShipping(false); }
  };

  const setMsgActionState = (index, patch) => {
    setMessages((cur) => cur.map((m, i) => (i === index ? { ...m, ...patch } : m)));
  };

  const runProposedAction = async (index, action) => {
    setMsgActionState(index, { actionState: 'running' });
    try {
      const { data: res } = await base44.functions.invoke('wordPressStoreAction', { projectId, action: action.action, data: action.data });
      if (res && res.ok === false) {
        setMsgActionState(index, { actionState: 'error', actionError: res.message || res.error || 'The site rejected it.' });
      } else {
        setMsgActionState(index, { actionState: 'done' });
      }
    } catch (e) {
      setMsgActionState(index, { actionState: 'error', actionError: e?.data?.error || e.message });
    }
  };

  // Same confirm-then-run pattern as a single proposedAction, but runs each
  // already-resolved item in the bulk list one at a time so the card can
  // show live per-item progress instead of one all-or-nothing spinner.
  const runProposedBulkAction = async (index, bulk) => {
    const results = bulk.items.map(() => ({ status: 'pending' }));
    setMsgActionState(index, { bulkState: 'running', bulkResults: results });
    for (let ii = 0; ii < bulk.items.length; ii++) {
      results[ii] = { status: 'running' };
      setMsgActionState(index, { bulkResults: [...results] });
      try {
        const { data: res } = await base44.functions.invoke('wordPressStoreAction', { projectId, action: bulk.items[ii].action, data: bulk.items[ii].data });
        results[ii] = (res && res.ok === false)
          ? { status: 'error', error: res.message || res.error || 'The site rejected it.' }
          : { status: 'done' };
      } catch (e) {
        results[ii] = { status: 'error', error: e?.data?.error || e.message };
      }
      setMsgActionState(index, { bulkResults: [...results] });
    }
    const anyError = results.some((r) => r.status === 'error');
    const allError = results.every((r) => r.status === 'error');
    setMsgActionState(index, { bulkState: allError ? 'error' : anyError ? 'partial' : 'done' });
  };

  const busy = sending || shipping || merge?.phase === 'polling';

  return (
    <div className="flex flex-col h-[520px]">
      <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-matrix p-4 space-y-3">
        {historyLoaded && messages.length === 0 && !sending && (
          <div className="text-[12px] text-ink/55 leading-relaxed">
            <div className="flex items-center gap-1.5 text-ink/80 mb-1"><Sparkles size={13} /> Ask Morpheus about {projectName || 'your site'}</div>
            {mode === 'context'
              ? 'Questions, ideas, a plan for a change — this is a discussion. Nothing here changes the site.'
              : 'Describe a change and Morpheus builds it for real — same pipeline as the full workspace. A turn that changes files gets a SHIP button right here.'}
            {pageUrl && <div className="mt-1.5 text-ink/40">It knows you’re looking at this page — ask about “this” or “here” and it’ll answer for what’s in front of you.</div>}
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i}>
            <div className={m.role === 'user' ? 'text-right' : ''}>
              <div className={`inline-block max-w-[85%] text-left px-3 py-2 text-[12px] leading-relaxed whitespace-pre-wrap break-words border ${
                m.role === 'user'
                  ? 'border-primary/30 bg-primary/5 text-ink/90'
                  : 'border-primary/15 text-ink/80'
              }`}>
                {m.content}
              </div>
            </div>

            {m.proposedAction && (
              <div className="mt-1.5 border border-yellow-500/35 bg-yellow-500/5 px-3 py-2.5 space-y-2 text-[11px]">
                {(!m.actionState || m.actionState === 'pending') && (
                  <>
                    <div className="flex items-center gap-1.5 text-yellow-500/90">
                      <AlertTriangle size={12} /> Are you sure? <span className="text-ink/80">{m.proposedAction.label}</span>
                    </div>
                    {canStore ? (
                      <div className="flex items-center gap-2">
                        <button onClick={() => setMsgActionState(i, { actionState: 'cancelled' })}
                          className="flex-1 flex items-center justify-center gap-1.5 h-[30px] border border-primary/30 text-primary/70 hover:text-primary hover:border-primary/60 text-[10px]">
                          <X size={11} /> Cancel
                        </button>
                        <button onClick={() => runProposedAction(i, m.proposedAction)}
                          className="flex-1 flex items-center justify-center gap-1.5 h-[30px] bg-yellow-500/90 text-black font-bold hover:bg-yellow-500 text-[10px]">
                          <Check size={11} /> Confirm
                        </button>
                      </div>
                    ) : (
                      <div className="text-ink/45">This widget's token can't run shop actions — do it from the SHOP or PAGES tab instead.</div>
                    )}
                  </>
                )}
                {m.actionState === 'running' && (
                  <div className="flex items-center gap-1.5 text-ink/60"><Loader2 size={11} className="animate-spin" /> Working…</div>
                )}
                {m.actionState === 'done' && (
                  <div className="flex items-center gap-1.5 text-ink"><Check size={12} /> Done — {m.proposedAction.label}</div>
                )}
                {m.actionState === 'error' && (
                  <div className="text-red-400">Failed: {m.actionError || 'unknown error'}</div>
                )}
                {m.actionState === 'cancelled' && (
                  <div className="text-ink/45">Cancelled — nothing changed.</div>
                )}
              </div>
            )}

            {m.proposedBulkAction && (
              <div className="mt-1.5 border border-yellow-500/35 bg-yellow-500/5 px-3 py-2.5 space-y-2 text-[11px]">
                {(!m.bulkState || m.bulkState === 'pending') && (
                  <>
                    <div className="flex items-center gap-1.5 text-yellow-500/90">
                      <AlertTriangle size={12} /> Are you sure? <span className="text-ink/80">{m.proposedBulkAction.label}</span>
                    </div>
                    <ul className="text-ink/70 space-y-0.5">
                      {m.proposedBulkAction.items.map((it) => <li key={it.id}>· {it.label}</li>)}
                    </ul>
                    {m.proposedBulkAction.unresolved.length > 0 && (
                      <div className="text-ink/45">
                        Couldn't match: {m.proposedBulkAction.unresolved.join(', ')} — check the name and ask again.
                      </div>
                    )}
                    {canStore ? (
                      <div className="flex items-center gap-2">
                        <button onClick={() => setMsgActionState(i, { bulkState: 'cancelled' })}
                          className="flex-1 flex items-center justify-center gap-1.5 h-[30px] border border-primary/30 text-primary/70 hover:text-primary hover:border-primary/60 text-[10px]">
                          <X size={11} /> Cancel
                        </button>
                        <button onClick={() => runProposedBulkAction(i, m.proposedBulkAction)}
                          className="flex-1 flex items-center justify-center gap-1.5 h-[30px] bg-yellow-500/90 text-black font-bold hover:bg-yellow-500 text-[10px]">
                          <Check size={11} /> Confirm all
                        </button>
                      </div>
                    ) : (
                      <div className="text-ink/45">This widget's token can't run shop actions — do it from the SHOP or PAGES tab instead.</div>
                    )}
                  </>
                )}
                {(m.bulkState === 'running' || m.bulkState === 'done' || m.bulkState === 'partial' || m.bulkState === 'error') && (
                  <div className="space-y-1">
                    {m.proposedBulkAction.items.map((it, ii) => {
                      const r = m.bulkResults?.[ii];
                      const status = r?.status;
                      return (
                        <div key={it.id} className={`flex items-center gap-1.5 ${status === 'error' ? 'text-red-400' : status === 'done' ? 'text-ink' : 'text-ink/60'}`}>
                          {status === 'running' && <Loader2 size={11} className="animate-spin shrink-0" />}
                          {status === 'done' && <Check size={11} className="shrink-0" />}
                          {status === 'error' && <X size={11} className="shrink-0" />}
                          {(!status || status === 'pending') && <span className="w-[11px] shrink-0" />}
                          <span className="truncate">{it.label}{status === 'error' && r.error ? ` — ${r.error}` : ''}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
                {m.bulkState === 'cancelled' && (
                  <div className="text-ink/45">Cancelled — nothing changed.</div>
                )}
              </div>
            )}
          </div>
        ))}

        {sending && (
          <div className="flex items-center gap-2 text-[11px] text-ink/50">
            <Loader2 size={12} className="animate-spin" /> {stage || (mode === 'build' ? 'Morpheus is building' : 'Morpheus is thinking')}…
          </div>
        )}

        {lastBuild && (
          <div className="border border-primary/30 bg-primary/5 px-3 py-2.5 space-y-2 text-[11px]">
            <div className="flex items-center gap-1.5 text-ink/85">
              <Check size={12} /> {lastBuild.paths.length} file{lastBuild.paths.length === 1 ? '' : 's'} changed
            </div>
            <div className="space-y-0.5 max-h-16 overflow-y-auto scrollbar-matrix">
              {lastBuild.paths.map((p) => <div key={p} className="text-[10px] text-ink/50 font-mono truncate">{p}</div>)}
            </div>

            {!canShip && (
              <div className="text-ink/45">Saved to the project. This widget's token can't ship — open the WEBSITE panel's DEPLOY tab to send it live.</div>
            )}

            {canShip && !ship?.shipped && (
              <div className="flex items-center gap-2 pt-1">
                <button onClick={runDryRun} disabled={running || busy}
                  className="flex-1 flex items-center justify-center gap-1.5 h-[32px] border border-primary/40 text-primary/80 hover:border-primary hover:text-primary text-[10px] disabled:opacity-40">
                  {running ? <Loader2 size={11} className="animate-spin" /> : <FileDiff size={11} />} DRY RUN
                </button>
                <button onClick={runShip} disabled={busy}
                  className="flex-1 flex items-center justify-center gap-1.5 h-[32px] bg-primary text-black font-bold text-[10px] hover:bg-[#39ff14] disabled:opacity-40">
                  {shipping ? <Loader2 size={11} className="animate-spin" /> : <Rocket size={11} />} SHIP TO SITE
                </button>
              </div>
            )}

            {diff && (
              diff.changed
                ? <div className="text-ink/60">{diff.createCount} new · {diff.updateCount} changed · {diff.deleteCount} deleted</div>
                : <div className="text-ink/45">Nothing to deploy — the site already matches this.</div>
            )}

            {ship?.shipped === false && ship.reason === 'no-changes' && (
              <div className="text-ink/45">Nothing to ship — the repo already matches this project.</div>
            )}
            {ship?.blocked && <div className="text-red-400">Syntax check failed — nothing was pushed.</div>}

            {ship?.shipped && (
              <div className="space-y-1.5 pt-1 border-t border-primary/15">
                <a href={ship.prUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-primary/80 hover:text-primary">
                  <GitPullRequest size={11} /> PR #{ship.prNumber} <ExternalLink size={10} />
                </a>
                {(!merge || merge.phase === 'polling') && (
                  <div className="flex items-center gap-1.5 text-ink/55">
                    <Loader2 size={11} className="animate-spin" /> {merge?.result?.note || 'Waiting for checks, then merging…'}
                  </div>
                )}
                {merge?.phase === 'failed' && <div className="text-red-400">{merge.result.message || 'Checks failed — see the PR.'}</div>}
                {merge?.phase === 'merged' && (
                  <div className="flex items-center gap-1.5 text-ink"><Check size={12} /> Merged{merge.result.deploy?.triggered ? ' — deployed live.' : '.'}</div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {err && <div className="mx-4 mb-2 text-red-400 text-[11px] border border-red-500/30 px-3 py-2">{err}</div>}

      <div className="flex border-t border-primary/20 shrink-0 text-[10px]">
        <button onClick={() => setMode('context')} disabled={sending}
          className={`flex-1 h-[30px] flex items-center justify-center gap-1.5 ${mode === 'context' ? 'text-primary border-b-2 border-primary' : 'text-primary/40'}`}>
          <MessagesSquare size={11} /> DISCUSS
        </button>
        <button onClick={() => setMode('build')} disabled={sending}
          className={`flex-1 h-[30px] flex items-center justify-center gap-1.5 ${mode === 'build' ? 'text-primary border-b-2 border-primary' : 'text-primary/40'}`}>
          <Hammer size={11} /> BUILD
        </button>
      </div>

      <div className="p-3 flex items-end gap-2">
        <textarea
          className="flex-1 bg-black/30 border border-primary/20 px-2.5 py-2 text-[13px] text-primary focus:outline-none focus:border-primary/50 resize-none"
          rows={2}
          placeholder={mode === 'build' ? 'Describe the change…' : 'Ask about your site…'}
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
