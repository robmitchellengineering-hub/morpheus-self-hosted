import { useState, useEffect, useCallback } from 'react';
import {
  X, HeartPulse, ScrollText, Database, DollarSign, PackageSearch, SlidersHorizontal,
  ListChecks, Loader2, CheckCircle2, XCircle, AlertTriangle, RefreshCw, Plus, Trash2, Check,
} from 'lucide-react';
import { base44 } from '@/api/base44Client';

// Operations console for a self-hosted Morpheus, folded into Self-Dev so
// "develop it" and "run it" live in one place (2026-09-09, Rob). Every
// section here is backed by an endpoint that already existed for the Admin
// panel's Ops Console or Overview — this is a second, operationally-framed
// view of the same data, not new capability. The Admin panel keeps the
// non-operational tabs (model routing, margins, audit log).
//
// Access: Self-Dev is already admin-role gated and every endpoint re-checks.

function Section({ title, hint, children, right }) {
  return (
    <div className="border border-primary/20 bg-primary/5 p-3">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="text-[11px] text-primary/55 tracking-widest uppercase">{title}</div>
        {right}
      </div>
      {hint && <p className="text-ink-max text-[11px] leading-relaxed mb-2">{hint}</p>}
      {children}
    </div>
  );
}

function Flag({ label, ok, unlocks }) {
  return (
    <div className="flex items-start justify-between gap-3 text-[11px] py-1.5 border-b border-primary/10 last:border-0">
      <div className="min-w-0">
        <span className="text-ink-max">{label}</span>
        {unlocks && <span className="block text-ink-max">{unlocks}</span>}
      </div>
      <span className={`shrink-0 ${ok ? 'text-ink-max' : 'text-ink-max'}`}>{ok ? 'CONFIGURED' : 'NOT SET'}</span>
    </div>
  );
}

const Busy = ({ label = 'Loading…' }) => (
  <div className="flex items-center gap-2 text-ink-strong text-xs py-6 justify-center">
    <Loader2 size={14} className="animate-spin" /> {label}
  </div>
);

// ── Health — black-box probe of the live deployment ─────────────────────
function HealthTab() {
  const [state, setState] = useState(null); // { phase: 'running'|'done', data? , error? }

  const run = useCallback(async () => {
    setState({ phase: 'running' });
    try {
      const { data } = await base44.functions.invoke('smokeCheckSelfDev', {});
      setState({ phase: 'done', data });
    } catch (e) {
      setState({ phase: 'done', error: e?.response?.data?.error || e.message });
    }
  }, []);

  useEffect(() => { run(); }, [run]);

  const data = state?.data;
  return (
    <div className="p-3 space-y-3">
      <Section
        title="Production health"
        hint="Hits the live production URLs directly — API health, an unauthenticated route, a function call, and the frontend shell. Needs no credentials."
        right={
          <button onClick={run} disabled={state?.phase === 'running'} className="flex items-center gap-1 text-[11px] border border-primary/40 px-2 py-1 text-primary/75 hover:text-primary hover:border-primary/70 disabled:opacity-40">
            <RefreshCw size={11} className={state?.phase === 'running' ? 'animate-spin' : ''} /> RE-RUN
          </button>
        }
      >
        {state?.phase === 'running' && <Busy label="Probing production…" />}
        {state?.error && <div className="text-red-400 text-xs border border-red-500/30 px-2 py-1.5">Couldn't run the check: {state.error}</div>}
        {data && (
          <>
            <div className={`flex items-center gap-2 text-sm mb-2 ${data.ok ? 'text-ink' : 'text-red-400'}`}>
              {data.ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
              <span className="font-display">{data.ok ? 'ALL CHECKS PASSED' : `${(data.failing || []).length} FAILING`}</span>
            </div>
            <div className="space-y-1">
              {(data.checks || []).map((c) => (
                <div key={c.name} className="flex items-start gap-2 text-[11px]">
                  {c.ok ? <CheckCircle2 size={12} className="text-primary shrink-0 mt-0.5" /> : <XCircle size={12} className="text-red-400 shrink-0 mt-0.5" />}
                  <span className="text-ink-max">{c.name}</span>
                  <span className="text-ink-max truncate">— {c.detail}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </Section>
    </div>
  );
}

// ── Logs — Northflank production logs (read-only, token-gated) ───────────
function LogsTab() {
  const [status, setStatus] = useState(null);
  const [search, setSearch] = useState('error');
  const [minutes, setMinutes] = useState(60);
  const [logs, setLogs] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [restart, setRestart] = useState(null); // null | 'confirm' | 'running' | { done, error }

  const loadStatus = useCallback(() => base44.admin.getNorthflankStatus().then(setStatus).catch((e) => setErr(e.message)), []);
  useEffect(() => { loadStatus(); }, [loadStatus]);

  const doRestart = async () => {
    setRestart('running');
    try {
      await base44.admin.restartNorthflankService();
      setRestart({ done: true });
      setTimeout(loadStatus, 3000);
    } catch (e) {
      setRestart({ error: e?.response?.data?.error || e.message });
    }
  };

  const pull = async () => {
    setLoading(true); setErr(null);
    try {
      const res = await base44.admin.getNorthflankLogs({ search, minutes, limit: 200 });
      if (res.configured === false) { setErr('not-configured'); setLogs([]); }
      else if (res.error) { setErr(res.error); setLogs([]); }
      else setLogs(res.lines || []);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  };

  const notConfigured = status?.configured === false || err === 'not-configured';

  return (
    <div className="p-3 space-y-3">
      <Section title="Production status & logs" hint="Read-only view of the Northflank service — build/deploy state and runtime logs.">
        {notConfigured && (
          <div className="text-yellow-500/90 text-[11px] border border-yellow-500/30 px-2 py-2 leading-relaxed">
            Northflank not connected. Create an API token with <span className="font-mono">View Services</span> + <span className="font-mono">View Observability</span> on this project only, set it as <span className="font-mono text-yellow-400">NORTHFLANK_API_TOKEN</span> in the backend environment. Deploy status, logs and the auto-diagnose-on-failed-deploy watcher all light up once it's set.
          </div>
        )}
        {status?.configured && status.service && (
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className="text-[11px] text-ink-max">
              Build: <span className="text-ink-max">{status.service?.status?.build?.status || 'unknown'}</span>
              {status.service?.name ? ` — ${status.service.name}` : ''}
            </div>
            {status.writeEnabled ? (
              <button onClick={() => setRestart('confirm')} disabled={restart === 'running'} className="flex items-center gap-1 text-[11px] border border-yellow-500/50 text-yellow-500 px-2 py-1 hover:bg-yellow-500/10 disabled:opacity-40">
                <RefreshCw size={11} className={restart === 'running' ? 'animate-spin' : ''} /> RESTART SERVICE
              </button>
            ) : (
              <span className="text-ink-max text-[10px]" title="Set NORTHFLANK_WRITE_ENABLED=true and give the token Services > Update scope">restart disabled</span>
            )}
          </div>
        )}
        {restart?.done && <div className="text-ink-max text-[11px] border border-primary/20 bg-primary/5 px-2 py-1.5 mb-2">Restart requested — the backend is rolling its containers. Watch the logs below.</div>}
        {restart?.error && <div className="text-red-400 text-[11px] border border-red-500/30 px-2 py-1.5 mb-2">Restart failed: {restart.error}</div>}
        {!notConfigured && (
          <>
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="filter text" className="flex-1 min-w-[8rem] bg-black/30 border border-primary/20 px-2 py-1 text-[11px] text-ink-max focus:outline-none focus:border-primary/50" />
              <input type="number" value={minutes} min={1} max={1440} onChange={(e) => setMinutes(e.target.value)} className="w-16 bg-black/30 border border-primary/20 px-2 py-1 text-[11px] text-ink-max focus:outline-none focus:border-primary/50" />
              <span className="text-ink-max text-[11px]">min</span>
              <button onClick={pull} disabled={loading} className="flex items-center gap-1 text-[11px] border border-primary/40 px-2 py-1 text-primary/75 hover:text-primary hover:border-primary/70 disabled:opacity-40">
                {loading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />} PULL
              </button>
            </div>
            {err && err !== 'not-configured' && <div className="text-red-400 text-[11px] mb-2">{err}</div>}
            {logs && (
              <div className="max-h-72 overflow-y-auto scrollbar-matrix bg-black/40 border border-primary/10 p-2 font-mono text-[10px] text-ink-max space-y-0.5">
                {logs.length === 0 && <div className="text-ink-max italic">No matching lines.</div>}
                {logs.map((l, i) => (
                  <div key={i} className="whitespace-pre-wrap break-all">
                    <span className="text-ink-max">{l.ts ? new Date(l.ts).toLocaleTimeString() : ''}</span> {l.log}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </Section>

      {restart === 'confirm' && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4" onClick={() => setRestart(null)}>
          <div className="bg-background border border-yellow-500/40 max-w-md w-full p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-3 text-yellow-500"><AlertTriangle size={18} /><span className="font-display tracking-wider">RESTART PRODUCTION</span></div>
            <p className="text-ink-max text-[11px] mb-4 leading-relaxed">
              This does a rolling restart of the live <span className="text-ink-max">{status?.service?.name || 'backend'}</span> containers — same build, no rebuild. Requests in flight may drop for a few seconds. Logged to the audit trail.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setRestart(null)} className="px-3 py-1.5 border border-primary/30 text-primary/70 hover:text-primary text-[11px]">CANCEL</button>
              <button onClick={doRestart} className="flex items-center gap-1 px-3 py-1.5 border border-yellow-500 bg-yellow-500/10 text-yellow-500 hover:bg-yellow-500/20 text-[11px] font-bold">
                <RefreshCw size={12} /> RESTART NOW
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Database — guarded SQL console ──────────────────────────────────────
function DatabaseTab() {
  const [sql, setSql] = useState('SELECT email, role, credit_balance FROM users ORDER BY created_date DESC LIMIT 20;');
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);
  const [running, setRunning] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const isWrite = /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql);

  const run = async (confirmed = false) => {
    if (isWrite && !confirmed) { setConfirm(true); return; }
    setRunning(true); setErr(null); setResult(null);
    try { setResult(await base44.admin.runDbQuery(sql, confirmed)); }
    catch (e) { setErr(e.message); }
    finally { setRunning(false); setConfirm(false); }
  };

  return (
    <div className="p-3 space-y-3">
      <Section title="Database console" hint="Direct SQL against this deployment's database. SELECT/WITH run immediately; INSERT/UPDATE/DELETE confirm first. Both are audit-logged. Schema changes are rejected — those need a migration.">
        <textarea value={sql} onChange={(e) => setSql(e.target.value)} rows={4} spellCheck={false} className="w-full bg-black/30 border border-primary/20 px-2 py-1.5 text-[11px] text-ink-max font-mono focus:outline-none focus:border-primary/50 mb-2" />
        <button onClick={() => run(false)} disabled={running || !sql.trim()} className={`flex items-center gap-1 px-3 py-1.5 border text-[11px] disabled:opacity-30 ${isWrite ? 'border-yellow-500/60 text-yellow-500 hover:bg-yellow-500/10' : 'border-primary/50 text-primary/80 hover:border-primary hover:text-primary'}`}>
          {running ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} {isWrite ? 'RUN (WRITE)' : 'RUN'}
        </button>
        {err && <div className="text-red-400 text-[11px] border border-red-500/30 px-2 py-1.5 mt-2">{err}</div>}
        {result?.rows && (
          <div className="overflow-x-auto max-h-72 overflow-y-auto scrollbar-matrix border border-primary/10 mt-2">
            <table className="w-full text-[10px]">
              <thead>
                <tr className="text-ink-max text-left border-b border-primary/10 sticky top-0 bg-background">
                  {result.rows[0] ? Object.keys(result.rows[0]).map((c) => <th key={c} className="py-1 px-2">{c}</th>) : <th className="py-1 px-2">(no columns)</th>}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, i) => (
                  <tr key={i} className="border-b border-primary/5 last:border-0">
                    {Object.values(row).map((v, j) => (
                      <td key={j} className="py-1 px-2 text-ink-max whitespace-pre-wrap break-all">{v === null ? <span className="text-ink-max italic">null</span> : String(v)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="text-ink-max text-[10px] px-2 py-1">{result.rowCount} row(s){result.truncated ? ' (truncated to 500)' : ''}</div>
          </div>
        )}
        {result?.rowsAffected !== undefined && <div className="text-ink-max text-[11px] mt-2">{result.rowsAffected} row(s) affected.</div>}
      </Section>

      {confirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4" onClick={() => setConfirm(false)}>
          <div className="bg-background border border-yellow-500/40 max-w-lg w-full p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-3 text-yellow-500"><AlertTriangle size={18} /><span className="font-display tracking-wider">CONFIRM WRITE</span></div>
            <pre className="text-ink-max text-[11px] bg-black/40 border border-primary/10 p-2 mb-4 overflow-x-auto whitespace-pre-wrap break-all">{sql}</pre>
            <p className="text-ink-max text-[11px] mb-4">Runs against production data and is logged to the audit trail.</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirm(false)} className="px-3 py-1.5 border border-primary/30 text-primary/70 hover:text-primary text-[11px]">CANCEL</button>
              <button onClick={() => run(true)} disabled={running} className="flex items-center gap-1 px-3 py-1.5 border border-yellow-500 bg-yellow-500/10 text-yellow-500 hover:bg-yellow-500/20 text-[11px] font-bold">
                {running ? <Loader2 size={12} className="animate-spin" /> : null} RUN WRITE
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Spend — usage & cost, and the DeepSeek balance safeguard ────────────
function SpendTab() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { base44.admin.getOverview().then(setData).catch((e) => setErr(e.message)); }, []);
  if (err) return <div className="p-3 text-red-400 text-xs">{err}</div>;
  if (!data) return <Busy />;
  const bal = data.deepseekBalance;
  return (
    <div className="p-3 space-y-3">
      <Section title="Spend — last 30 days">
        <div className="grid grid-cols-3 gap-2 mb-3">
          <div><div className="text-[10px] text-primary/50">USERS</div><div className="text-lg font-display">{data.totalUsers}</div></div>
          <div><div className="text-[10px] text-primary/50">ACTIVE 7D</div><div className="text-lg font-display">{data.activeUsers7d}</div></div>
          <div><div className="text-[10px] text-primary/50">COST 30D</div><div className="text-lg font-display">${(data.totalCost30d || 0).toFixed(2)}</div></div>
        </div>
        {(data.usageByModel30d || []).length === 0 && <div className="text-ink-max text-[11px] italic">No usage recorded yet.</div>}
        {(data.usageByModel30d || []).length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-[10px]">
              <thead><tr className="text-ink-max text-left border-b border-primary/10"><th className="py-1 pr-2">MODEL</th><th className="py-1 pr-2 text-right">CALLS</th><th className="py-1 pr-2 text-right">IN</th><th className="py-1 pr-2 text-right">OUT</th><th className="py-1 text-right">COST</th></tr></thead>
              <tbody>
                {data.usageByModel30d.map((r) => (
                  <tr key={`${r.provider}:${r.modelId}`} className="border-b border-primary/5 last:border-0">
                    <td className="py-1 pr-2 text-ink-max">{r.modelId}</td>
                    <td className="py-1 pr-2 text-right text-ink-max">{r.calls}</td>
                    <td className="py-1 pr-2 text-right text-ink-max">{(r.inputTokens || 0).toLocaleString()}</td>
                    <td className="py-1 pr-2 text-right text-ink-max">{(r.outputTokens || 0).toLocaleString()}</td>
                    <td className="py-1 text-right text-primary/70">${(r.costUsd || 0).toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      {bal?.deepseekPrimary && (
        <Section title="DeepSeek balance safeguard" hint="DeepSeek runs on a prepaid balance; at zero every AI call fails at once. A scheduled check warns before that and fails over to the fallback provider. Topping up is a manual action at platform.deepseek.com/top_up.">
          <div className={`flex items-center gap-2 text-sm ${bal.level === 'ok' ? 'text-ink' : bal.level === 'warning' ? 'text-yellow-500' : bal.level === 'unavailable' ? 'text-red-400' : 'text-ink'}`}>
            {bal.level === 'ok' ? <CheckCircle2 size={15} /> : bal.level === 'unavailable' ? <XCircle size={15} /> : <AlertTriangle size={15} />}
            <span className="font-display">{(bal.level || 'unknown').toUpperCase()}</span>
            {bal.totalUsd != null && <span className="text-primary/50">— ${Number(bal.totalUsd).toFixed(2)}</span>}
          </div>
          <div className="mt-1"><Flag label="Fallback provider (FALLBACK_LLM_*)" ok={bal.fallbackConfigured} /></div>
          {bal.checkedAt && <div className="text-ink-max text-[10px] mt-1">Last checked {new Date(bal.checkedAt).toLocaleString()}</div>}
        </Section>
      )}
    </div>
  );
}

// ── Currency — AI model + dependency freshness ──────────────────────────
function CurrencyTab() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try { setData(await base44.admin.getFreshness()); } catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const refresh = async () => {
    setRefreshing(true); setErr(null);
    try { setData(await base44.admin.refreshFreshness(false)); } catch (e) { setErr(e.message); }
    finally { setRefreshing(false); }
  };

  if (err) return <div className="p-3 text-red-400 text-xs">{err}</div>;
  if (!data) return <Busy />;

  const dep = (section) => {
    if (!section?.checked) return <div className="text-ink-max text-[11px] italic">not checked{section?.reason ? ` — ${section.reason}` : ''}</div>;
    if (section.outdatedCount === 0) return <div className="text-ink-max text-[11px]">all {section.totalDependencies} up to date</div>;
    return (
      <div className="max-h-44 overflow-y-auto scrollbar-matrix mt-1 space-y-0.5">
        {(section.outdated || []).map((d) => (
          <div key={d.name} className="flex items-center justify-between text-[10px] font-mono">
            <span className="text-ink-max">{d.name}</span>
            <span className="text-ink-max">{d.current} → <span className={d.majorBump ? 'text-yellow-500' : 'text-ink-max'}>{d.latest}</span>{d.majorBump ? ' (major)' : ''}</span>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="p-3 space-y-3">
      <Section
        title="Currency"
        hint="What's behind: the pinned AI model vs the newest one, and outdated npm packages front + back. This also runs on a schedule and emails on change; nothing here auto-upgrades."
        right={
          <button onClick={refresh} disabled={refreshing} className="flex items-center gap-1 text-[11px] border border-primary/40 px-2 py-1 text-primary/75 hover:text-primary hover:border-primary/70 disabled:opacity-40">
            <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} /> CHECK NOW
          </button>
        }
      >
        <div className="text-[11px] mb-3">
          <div className="text-primary/55 uppercase tracking-wider text-[10px] mb-1">AI model</div>
          {data.ai?.configured
            ? <div className="text-ink-max">pinned <span className="text-ink-max">{data.ai.configuredModel || 'auto'}</span> → resolves to <span className="text-ink-max">{data.ai.currentlyResolvesTo || '?'}</span>{data.ai.driftedFromPinned ? <span className="text-yellow-500"> — newer available: {data.ai.newestKnownModel}</span> : ''}</div>
            : <div className="text-ink-max">AI not configured{data.ai?.error ? ` — ${data.ai.error}` : ''}</div>}
        </div>
        <div className="text-[11px] mb-3">
          <div className="text-primary/55 uppercase tracking-wider text-[10px] mb-1">Backend packages</div>
          {dep(data.serverDeps)}
        </div>
        <div className="text-[11px]">
          <div className="text-primary/55 uppercase tracking-wider text-[10px] mb-1">Frontend packages</div>
          {dep(data.frontendDeps)}
        </div>
        {data.checkedAt && <div className="text-ink-max text-[10px] mt-3">Last checked {new Date(data.checkedAt).toLocaleString()}</div>}
      </Section>
    </div>
  );
}

// ── Config — which env secrets are set and what they unlock ─────────────
function ConfigTab() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { base44.admin.getOverview().then(setData).catch((e) => setErr(e.message)); }, []);
  if (err) return <div className="p-3 text-red-400 text-xs">{err}</div>;
  if (!data) return <Busy />;
  const f = data.configFlags || {};
  return (
    <div className="p-3 space-y-3">
      <Section title="Config & secrets" hint="Presence only — values are never shown. Set these in the backend environment (Northflank → service → env).">
        <Flag label="LLM_API_KEY" ok={f.llmApiKeyConfigured} unlocks="the house AI provider" />
        <Flag label="Morpheus Cloud gateway" ok={f.morpheusCloudConfigured} unlocks="AI + OAuth without your own keys" />
        <Flag label="STRIPE_SECRET_KEY" ok={f.stripeConfigured} unlocks="paid credits / token top-ups" />
        <Flag label="SMTP_HOST" ok={f.smtpConfigured} unlocks="verification + currency-alert email" />
        <Flag label="FALLBACK_LLM_*" ok={data.deepseekBalance?.fallbackConfigured} unlocks="failover + free Gemini web-search grounding" />
      </Section>
      <p className="text-ink-max text-[11px] px-1">Model routing, per-model margins and the audit log live in the <span className="text-ink-max">full Admin panel</span>.</p>
    </div>
  );
}

// ── Punch list — MaintenanceTask CRUD ──────────────────────────────────
function PunchListTab() {
  const [tasks, setTasks] = useState(null);
  const [err, setErr] = useState(null);
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try { setTasks(await base44.entities.MaintenanceTask.list('-created_date')); } catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const add = async () => {
    if (!title.trim()) return;
    setSaving(true);
    try { await base44.entities.MaintenanceTask.create({ title: title.trim() }); setTitle(''); await load(); }
    catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  };
  const toggle = async (t) => {
    try { await base44.entities.MaintenanceTask.update(t.id, { done: !t.done }); setTasks((c) => c.map((x) => x.id === t.id ? { ...x, done: !x.done } : x)); }
    catch (e) { setErr(e.message); }
  };
  const remove = async (t) => {
    try { await base44.entities.MaintenanceTask.delete(t.id); setTasks((c) => c.filter((x) => x.id !== t.id)); }
    catch (e) { setErr(e.message); }
  };

  if (!tasks) return <Busy />;
  const open = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done);
  return (
    <div className="p-3">
      <Section title="Maintenance punch list" hint="Things to get to — persists across sessions.">
        {err && <div className="text-red-400 text-[11px] border border-red-500/30 px-2 py-1.5 mb-2">{err}</div>}
        <div className="flex items-center gap-2 mb-3">
          <input value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} placeholder="add a task…" className="flex-1 bg-black/30 border border-primary/20 px-2 py-1.5 text-[11px] text-ink-max focus:outline-none focus:border-primary/50" />
          <button onClick={add} disabled={saving || !title.trim()} className="flex items-center gap-1 px-3 py-1.5 border border-primary/50 text-primary/80 hover:border-primary hover:text-primary text-[11px] disabled:opacity-30">
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} ADD
          </button>
        </div>
        {tasks.length === 0 && <div className="text-ink-max text-[11px] italic py-2 text-center">Nothing on the list.</div>}
        <div className="space-y-1">
          {open.map((t) => (
            <div key={t.id} className="flex items-center gap-2 text-[11px] group">
              <button onClick={() => toggle(t)} className="w-3.5 h-3.5 border border-primary/40 shrink-0 hover:border-primary" />
              <span className="flex-1 text-ink-max">{t.title}</span>
              <button onClick={() => remove(t)} className="text-primary/30 hover:text-red-400 opacity-0 group-hover:opacity-100"><Trash2 size={12} /></button>
            </div>
          ))}
          {done.map((t) => (
            <div key={t.id} className="flex items-center gap-2 text-[11px] group">
              <button onClick={() => toggle(t)} className="w-3.5 h-3.5 border border-primary/40 bg-primary/30 flex items-center justify-center shrink-0"><Check size={9} className="text-primary" /></button>
              <span className="flex-1 text-ink-max line-through">{t.title}</span>
              <button onClick={() => remove(t)} className="text-primary/30 hover:text-red-400 opacity-0 group-hover:opacity-100"><Trash2 size={12} /></button>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

const TABS = [
  { id: 'health', label: 'HEALTH', icon: HeartPulse, Comp: HealthTab },
  { id: 'logs', label: 'LOGS', icon: ScrollText, Comp: LogsTab },
  { id: 'db', label: 'DATABASE', icon: Database, Comp: DatabaseTab },
  { id: 'spend', label: 'SPEND', icon: DollarSign, Comp: SpendTab },
  { id: 'currency', label: 'CURRENCY', icon: PackageSearch, Comp: CurrencyTab },
  { id: 'config', label: 'CONFIG', icon: SlidersHorizontal, Comp: ConfigTab },
  { id: 'punch', label: 'PUNCH LIST', icon: ListChecks, Comp: PunchListTab },
];

export default function OpsPanel({ open, onClose }) {
  const [tab, setTab] = useState('health');
  if (!open) return null;
  const Active = TABS.find((t) => t.id === tab)?.Comp || HealthTab;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/80" onClick={onClose}>
      <div className="bg-background border-l border-primary/40 w-full max-w-xl h-full flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-primary/20 shrink-0">
          <div className="flex items-center gap-2">
            <HeartPulse size={16} className="text-primary" />
            <span className="text-primary font-display tracking-wider text-sm">OPS — RUN THE DEPLOYMENT</span>
          </div>
          <button onClick={onClose} className="text-primary/60 hover:text-primary"><X size={18} /></button>
        </div>
        <div className="flex border-b border-primary/20 shrink-0 overflow-x-auto scrollbar-matrix">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button key={id} onClick={() => setTab(id)} className={`flex items-center gap-1.5 px-3 py-2.5 text-[11px] tracking-wider whitespace-nowrap transition-colors ${tab === id ? 'text-primary border-b-2 border-primary bg-primary/5' : 'text-primary/60 hover:text-primary'}`}>
              <Icon size={13} /> {label}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto scrollbar-matrix">
          <Active />
        </div>
      </div>
    </div>
  );
}
