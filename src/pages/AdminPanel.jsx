import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  ShieldCheck, Loader2, ArrowLeft, Users, Activity, DollarSign,
  Settings2, ListChecks, ScrollText, Plus, Trash2, Check, RefreshCw,
  AlertTriangle, CheckCircle2, XCircle, Terminal, Cpu, FileText, Download, FileDown,
} from 'lucide-react';
import jsPDF from 'jspdf';
import { base44 } from '@/api/base44Client';
import MatrixRain from '@/components/matrix/MatrixRain';

// Owner/Admin Control Panel (Feature Backlog #8). New — not a base44 port.
// Backed by server/src/routes/admin.routes.js. Access control: role-gated
// (User.role === 'admin'), same bar as UpdatesPlan/SelfDev/CostTracker.
// Everything that writes here is server-side audited (AdminAuditLog) —
// the Audit Log tab is that log, so nothing here is a silent change.
const TABS = [
  { id: 'overview', label: 'OVERVIEW', icon: Activity },
  { id: 'models', label: 'MODELS & ROUTING', icon: DollarSign },
  { id: 'settings', label: 'CONFIG', icon: Settings2 },
  { id: 'tasks', label: 'PUNCH LIST', icon: ListChecks },
  { id: 'ops', label: 'OPS CONSOLE', icon: Terminal },
  { id: 'audit', label: 'AUDIT LOG', icon: ScrollText },
];

function Card({ children, className = '' }) {
  return <div className={`border border-primary/20 bg-primary/5 p-4 ${className}`}>{children}</div>;
}

function Flag({ label, ok }) {
  return (
    <div className="flex items-center justify-between text-xs py-1.5 border-b border-primary/10 last:border-0">
      <span className="text-primary/70">{label}</span>
      <span className={ok ? 'text-primary' : 'text-primary/40'}>{ok ? 'CONFIGURED' : 'NOT SET'}</span>
    </div>
  );
}

function OverviewTab() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await base44.admin.getOverview());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="flex items-center gap-2 text-primary/60 text-sm py-12 justify-center"><Loader2 size={16} className="animate-spin" /> Loading...</div>;
  if (error) return <div className="text-red-500 text-sm border border-red-500/30 px-3 py-2">{error}</div>;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <div className="flex items-center gap-2 text-primary/60 text-xs mb-1"><Users size={13} /> TOTAL USERS</div>
          <div className="text-2xl font-display">{data.totalUsers}</div>
        </Card>
        <Card>
          <div className="flex items-center gap-2 text-primary/60 text-xs mb-1"><Activity size={13} /> ACTIVE (7D)</div>
          <div className="text-2xl font-display">{data.activeUsers7d}</div>
        </Card>
        <Card>
          <div className="flex items-center gap-2 text-primary/60 text-xs mb-1"><DollarSign size={13} /> COST (30D)</div>
          <div className="text-2xl font-display">${(data.totalCost30d || 0).toFixed(2)}</div>
        </Card>
      </div>

      <Card>
        <div className="text-xs text-primary/60 mb-2 tracking-wider">USAGE BY MODEL — LAST 30 DAYS</div>
        {data.usageByModel30d.length === 0 && <div className="text-primary/40 text-xs italic py-4 text-center">No usage recorded yet.</div>}
        {data.usageByModel30d.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-primary/50 text-left border-b border-primary/10">
                  <th className="py-1.5 pr-3">MODEL</th>
                  <th className="py-1.5 pr-3">PROVIDER</th>
                  <th className="py-1.5 pr-3 text-right">CALLS</th>
                  <th className="py-1.5 pr-3 text-right">IN TOK</th>
                  <th className="py-1.5 pr-3 text-right">OUT TOK</th>
                  <th className="py-1.5 text-right">COST</th>
                </tr>
              </thead>
              <tbody>
                {data.usageByModel30d.map((r) => (
                  <tr key={`${r.provider}:${r.modelId}`} className="border-b border-primary/5 last:border-0">
                    <td className="py-1.5 pr-3 text-primary/80">{r.modelId}</td>
                    <td className="py-1.5 pr-3 text-primary/60">{r.provider}</td>
                    <td className="py-1.5 pr-3 text-right text-primary/70">{r.calls}</td>
                    <td className="py-1.5 pr-3 text-right text-primary/70">{r.inputTokens.toLocaleString()}</td>
                    <td className="py-1.5 pr-3 text-right text-primary/70">{r.outputTokens.toLocaleString()}</td>
                    <td className="py-1.5 text-right text-primary/70">${r.costUsd.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <div className="text-xs text-primary/60 mb-2 tracking-wider">CONFIG PRESENCE (SECRET VALUES NEVER SHOWN)</div>
        <Flag label="LLM API key" ok={data.configFlags.llmApiKeyConfigured} />
        <Flag label="Morpheus Cloud gateway" ok={data.configFlags.morpheusCloudConfigured} />
        <Flag label="Stripe" ok={data.configFlags.stripeConfigured} />
        <Flag label="SMTP" ok={data.configFlags.smtpConfigured} />
      </Card>

      {data.deepseekBalance?.deepseekPrimary && <DeepSeekBalanceCard status={data.deepseekBalance} />}
    </div>
  );
}

// Token System Build Plan Step 6b — DeepSeek runs on a prepaid balance;
// hitting zero fails every AI call platform-wide at once. This card is the
// only UI for that safeguard (backend: server/src/lib/deepseekBalance.js,
// a scheduled check + automatic failover to FALLBACK_LLM_*, never an
// automated recharge — actually moving money stays a human action, done at
// https://platform.deepseek.com/top_up). Only rendered when DeepSeek is
// actually this deployment's primary provider.
function DeepSeekBalanceCard({ status }) {
  const level = status.level || 'unknown';
  const cfg = {
    ok: { icon: CheckCircle2, color: 'text-primary', label: 'HEALTHY' },
    warning: { icon: AlertTriangle, color: 'text-yellow-500', label: 'LOW BALANCE' },
    unavailable: { icon: XCircle, color: 'text-red-500', label: 'DEPLETED' },
    unknown: { icon: AlertTriangle, color: 'text-primary/40', label: 'NOT YET CHECKED' },
  }[level] || { icon: AlertTriangle, color: 'text-primary/40', label: level.toUpperCase() };
  const Icon = cfg.icon;

  return (
    <Card>
      <div className="text-xs text-primary/60 mb-2 tracking-wider">DEEPSEEK BALANCE (STEP 6B SAFEGUARD)</div>
      <div className={`flex items-center gap-2 text-sm mb-2 ${cfg.color}`}>
        <Icon size={16} />
        <span className="font-display">{cfg.label}</span>
        {status.totalUsd != null && <span className="text-primary/50">— ${Number(status.totalUsd).toFixed(2)}</span>}
      </div>
      {status.error && <div className="text-red-500/80 text-xs mb-2">Last check failed: {status.error}</div>}
      <Flag label="Fallback provider configured (FALLBACK_LLM_*)" ok={status.fallbackConfigured} />
      {level === 'unavailable' && !status.fallbackConfigured && (
        <div className="text-red-500 text-xs mt-2 border border-red-500/30 px-2 py-1.5">
          No fallback configured — AI calls are failing platform-wide right now. Top up at platform.deepseek.com/top_up, or set FALLBACK_LLM_API_KEY/FALLBACK_LLM_BASE_URL/FALLBACK_LLM_MODEL.
        </div>
      )}
      <div className="text-primary/40 text-[11px] mt-2">
        {status.checkedAt ? `Last checked ${new Date(status.checkedAt).toLocaleString()}` : 'Not checked yet.'} · Warning threshold editable in CONFIG (key: deepseek_balance_min_usd).
      </div>
    </Card>
  );
}

function ModelsTab() {
  const [settings, setSettings] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState(null);
  const [draft, setDraft] = useState({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, c] = await Promise.all([base44.admin.getSettings(), base44.admin.getModelCatalog()]);
      setSettings(s);
      setCatalog(c);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const roles = ['default', 'planner', 'coder', 'reviewer', 'diagnosis'];

  const saveOverride = async (role, value) => {
    const key = role === 'default' ? 'default_model' : `default_${role}_model`;
    setSavingKey(key);
    try {
      await base44.admin.setSetting(key, value || null);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingKey(null);
    }
  };

  const saveCatalogEntry = async (modelId) => {
    const patch = draft[modelId];
    if (!patch) return;
    setSavingKey(`catalog:${modelId}`);
    try {
      await base44.admin.upsertModelCatalogEntry({ model_id: modelId, ...patch });
      setDraft((d) => ({ ...d, [modelId]: undefined }));
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingKey(null);
    }
  };

  if (loading) return <div className="flex items-center gap-2 text-primary/60 text-sm py-12 justify-center"><Loader2 size={16} className="animate-spin" /> Loading...</div>;
  if (error) return <div className="text-red-500 text-sm border border-red-500/30 px-3 py-2">{error}</div>;
  if (!settings || !catalog) return null;

  const knownModels = settings.knownModels || [];
  const catalogByModel = Object.fromEntries((catalog.entries || []).map((e) => [e.model_id, e]));
  const allModelIds = Array.from(new Set([...knownModels, ...Object.keys(catalogByModel)]));

  // 2026-09-02: quick DeepSeek Flash/Pro switch, on top of the generic
  // per-role override table below rather than replacing it — this just
  // writes the same "default_model" PlatformSetting the "default" row
  // already writes (see saveOverride), so both controls always agree.
  // Rob's ask: an easy way to flip which DeepSeek model actually serves
  // calls without hand-typing a model id. Retail already bills every
  // DeepSeek call at 2.0x Pro's peak rate regardless of which one runs
  // (server/src/lib/billing.js's resolveBillingRate) — Flash is far
  // cheaper to actually run (bigger margin), Pro is the higher-quality,
  // higher-cost option (margin compresses to the intended 2.0x).
  const effectiveDefault = (settings.settings.default_model || settings.envDefaults.base || '').trim();
  const DEEPSEEK_VARIANTS = [
    { id: 'deepseek-v4-flash', label: 'FLASH' },
    { id: 'deepseek-v4-pro', label: 'PRO' },
  ];

  return (
    <div className="space-y-4">
      <Card>
        <div className="text-xs text-primary/60 mb-1 tracking-wider">DEEPSEEK — LIVE MODEL</div>
        <p className="text-primary/50 text-xs mb-3">
          Switches which DeepSeek model actually serves calls platform-wide, no deploy needed. Retail
          already bills every DeepSeek call at 2.0&times; Pro's peak rate regardless of which one
          serves it, so this only changes real cost and margin, not what users are charged — Flash is
          far cheaper to run (bigger margin), Pro is the higher-quality / higher-cost option (margin
          compresses toward the intended 2.0&times;).
        </p>
        <div className="flex items-center gap-2">
          {DEEPSEEK_VARIANTS.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => saveOverride('default', id)}
              disabled={savingKey === 'default_model'}
              className={`flex items-center gap-2 border px-3 py-2 text-xs font-display tracking-wider transition-colors disabled:opacity-40 ${
                effectiveDefault === id ? 'border-primary bg-primary/10 text-primary' : 'border-primary/20 text-primary/60 hover:border-primary/40'
              }`}
            >
              {label}
              {effectiveDefault === id && <Check size={13} />}
            </button>
          ))}
          {savingKey === 'default_model' && <Loader2 size={13} className="animate-spin text-primary/60" />}
        </div>
        <div className="text-primary/40 text-[11px] mt-2">
          Effective now: <span className="text-primary/70 font-mono">{effectiveDefault || 'auto'}</span>
          {!settings.settings.default_model && ' (from env LLM_MODEL — no admin override set yet)'}
        </div>
      </Card>

      <Card>
        <div className="text-xs text-primary/60 mb-1 tracking-wider">PLATFORM DEFAULT MODEL ROUTING</div>
        <p className="text-primary/50 text-xs mb-3">
          Overrides "Automatic" model discovery per role, platform-wide. Leave blank for existing auto-discovery / env-var behavior. Never overrides an operator's LLM_*_MODEL env pin or a user's own Settings choice.
        </p>
        <div className="space-y-2">
          {roles.map((role) => {
            const key = role === 'default' ? 'default_model' : `default_${role}_model`;
            const envKey = role === 'default' ? 'base' : role;
            return (
              <div key={role} className="flex items-center gap-2">
                <span className="text-primary/70 text-xs w-24 shrink-0 uppercase">{role}</span>
                <input
                  defaultValue={settings.settings[key] || ''}
                  onBlur={(e) => { if (e.target.value !== (settings.settings[key] || '')) saveOverride(role, e.target.value.trim()); }}
                  placeholder={settings.envDefaults[envKey] || 'auto'}
                  className="flex-1 bg-black/30 border border-primary/20 px-2 py-1.5 text-xs text-primary focus:outline-none focus:border-primary/50"
                />
                {savingKey === key && <Loader2 size={13} className="animate-spin text-primary/60" />}
              </div>
            );
          })}
        </div>
      </Card>

      <Card>
        <div className="text-xs text-primary/60 mb-1 tracking-wider">MARGIN — MODEL PRICING &amp; MARKUP</div>
        <p className="text-primary/50 text-xs mb-3">$/M tokens x markup multiplier = billed rate. Blank price falls back to the static table.</p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-primary/50 text-left border-b border-primary/10">
                <th className="py-1.5 pr-2">MODEL</th>
                <th className="py-1.5 pr-2">IN $/M</th>
                <th className="py-1.5 pr-2">OUT $/M</th>
                <th className="py-1.5 pr-2">MARKUP</th>
                <th className="py-1.5 pr-2">ACTIVE</th>
                <th className="py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {allModelIds.map((modelId) => {
                const existing = catalogByModel[modelId] || {};
                const d = draft[modelId] || {};
                const get = (field, fallback) => (d[field] !== undefined ? d[field] : existing[field] ?? fallback);
                const setField = (field, value) => setDraft((cur) => ({ ...cur, [modelId]: { ...cur[modelId], [field]: value } }));
                return (
                  <tr key={modelId} className="border-b border-primary/5 last:border-0">
                    <td className="py-1.5 pr-2 text-primary/80">{modelId}</td>
                    <td className="py-1.5 pr-2">
                      <input type="number" step="0.01" value={get('input_price_per_m', '') ?? ''}
                        onChange={(e) => setField('input_price_per_m', e.target.value)}
                        className="w-20 bg-black/30 border border-primary/20 px-1.5 py-1 text-primary focus:outline-none focus:border-primary/50" />
                    </td>
                    <td className="py-1.5 pr-2">
                      <input type="number" step="0.01" value={get('output_price_per_m', '') ?? ''}
                        onChange={(e) => setField('output_price_per_m', e.target.value)}
                        className="w-20 bg-black/30 border border-primary/20 px-1.5 py-1 text-primary focus:outline-none focus:border-primary/50" />
                    </td>
                    <td className="py-1.5 pr-2">
                      <input type="number" step="0.1" value={get('markup_multiplier', 2.0) ?? 2.0}
                        onChange={(e) => setField('markup_multiplier', e.target.value)}
                        className="w-16 bg-black/30 border border-primary/20 px-1.5 py-1 text-primary focus:outline-none focus:border-primary/50" />
                    </td>
                    <td className="py-1.5 pr-2">
                      <input type="checkbox" checked={get('active', true) === true || get('active', true) === undefined}
                        onChange={(e) => setField('active', e.target.checked)} />
                    </td>
                    <td className="py-1.5">
                      <button
                        onClick={() => saveCatalogEntry(modelId)}
                        disabled={!draft[modelId] || savingKey === `catalog:${modelId}`}
                        className="text-primary/70 hover:text-primary disabled:opacity-30 disabled:hover:text-primary/70"
                        title="Save"
                      >
                        {savingKey === `catalog:${modelId}` ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function SettingsTab() {
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSettings(await base44.admin.getSettings());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const addSetting = async () => {
    if (!newKey.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await base44.admin.setSetting(newKey.trim(), newValue);
      setNewKey('');
      setNewValue('');
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const clearSetting = async (key) => {
    setSaving(true);
    try {
      await base44.admin.setSetting(key, null);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="flex items-center gap-2 text-primary/60 text-sm py-12 justify-center"><Loader2 size={16} className="animate-spin" /> Loading...</div>;

  const entries = Object.entries(settings?.settings || {});

  return (
    <div className="space-y-4">
      <Card>
        <div className="text-xs text-primary/60 mb-1 tracking-wider">GENERAL CONFIG / FEATURE FLAGS</div>
        <p className="text-primary/50 text-xs mb-3">
          Free-form admin-editable key/value store. Model-routing keys (default_model, default_planner_model, etc.) are also editable here, but the Models &amp; Routing tab is the friendlier way to set those.
        </p>
        {error && <div className="text-red-500 text-xs border border-red-500/30 px-2 py-1.5 mb-3">{error}</div>}

        {entries.length === 0 && <div className="text-primary/40 text-xs italic py-2">No overrides set — everything is on its default.</div>}
        {entries.length > 0 && (
          <div className="space-y-1.5 mb-4">
            {entries.map(([key, value]) => (
              <div key={key} className="flex items-center gap-2 text-xs">
                <span className="text-primary/80 font-bold w-48 shrink-0 truncate">{key}</span>
                <span className="flex-1 text-primary/60 truncate">{value}</span>
                <button onClick={() => clearSetting(key)} disabled={saving} className="text-primary/50 hover:text-red-400" title="Clear override">
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2 pt-3 border-t border-primary/10">
          <input value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="key"
            className="w-48 bg-black/30 border border-primary/20 px-2 py-1.5 text-xs text-primary focus:outline-none focus:border-primary/50" />
          <input value={newValue} onChange={(e) => setNewValue(e.target.value)} placeholder="value"
            className="flex-1 bg-black/30 border border-primary/20 px-2 py-1.5 text-xs text-primary focus:outline-none focus:border-primary/50" />
          <button onClick={addSetting} disabled={saving || !newKey.trim()}
            className="flex items-center gap-1 px-3 py-1.5 border border-primary/50 text-primary/80 hover:border-primary hover:text-primary text-xs disabled:opacity-30">
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} SET
          </button>
        </div>
      </Card>
    </div>
  );
}

function TasksTab() {
  const [tasks, setTasks] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [newTitle, setNewTitle] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTasks(await base44.entities.MaintenanceTask.list('-created_date'));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const addTask = async () => {
    if (!newTitle.trim()) return;
    setSaving(true);
    try {
      await base44.entities.MaintenanceTask.create({ title: newTitle.trim() });
      setNewTitle('');
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const toggleDone = async (task) => {
    try {
      await base44.entities.MaintenanceTask.update(task.id, { done: !task.done });
      setTasks((cur) => cur.map((t) => (t.id === task.id ? { ...t, done: !t.done } : t)));
    } catch (e) {
      setError(e.message);
    }
  };

  const removeTask = async (task) => {
    try {
      await base44.entities.MaintenanceTask.delete(task.id);
      setTasks((cur) => cur.filter((t) => t.id !== task.id));
    } catch (e) {
      setError(e.message);
    }
  };

  if (loading) return <div className="flex items-center gap-2 text-primary/60 text-sm py-12 justify-center"><Loader2 size={16} className="animate-spin" /> Loading...</div>;

  const open = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done);

  return (
    <Card>
      <div className="text-xs text-primary/60 mb-3 tracking-wider">MAINTENANCE PUNCH LIST</div>
      {error && <div className="text-red-500 text-xs border border-red-500/30 px-2 py-1.5 mb-3">{error}</div>}

      <div className="flex items-center gap-2 mb-4">
        <input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addTask(); }}
          placeholder="Add a task..."
          className="flex-1 bg-black/30 border border-primary/20 px-2 py-1.5 text-xs text-primary focus:outline-none focus:border-primary/50"
        />
        <button onClick={addTask} disabled={saving || !newTitle.trim()}
          className="flex items-center gap-1 px-3 py-1.5 border border-primary/50 text-primary/80 hover:border-primary hover:text-primary text-xs disabled:opacity-30">
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} ADD
        </button>
      </div>

      {tasks.length === 0 && <div className="text-primary/40 text-xs italic py-4 text-center">Nothing on the list.</div>}

      {open.length > 0 && (
        <div className="space-y-1 mb-3">
          {open.map((t) => (
            <div key={t.id} className="flex items-center gap-2 text-xs group">
              <button onClick={() => toggleDone(t)} className="w-4 h-4 border border-primary/40 flex items-center justify-center shrink-0 hover:border-primary" />
              <span className="flex-1 text-primary/80">{t.title}</span>
              <button onClick={() => removeTask(t)} className="text-primary/30 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {done.length > 0 && (
        <div className="space-y-1 pt-3 border-t border-primary/10">
          {done.map((t) => (
            <div key={t.id} className="flex items-center gap-2 text-xs group">
              <button onClick={() => toggleDone(t)} className="w-4 h-4 border border-primary/40 bg-primary/30 flex items-center justify-center shrink-0">
                <Check size={11} className="text-primary" />
              </button>
              <span className="flex-1 text-primary/40 line-through">{t.title}</span>
              <button onClick={() => removeTask(t)} className="text-primary/30 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// Ops Console (2026-09-02) — see server/src/routes/admin.routes.js's
// "C. Ops Console" section for the full reasoning. Three panels:
// Northflank status/logs (read-only), a DB console (read + guarded writes,
// per Rob's explicit choice 2026-09-02), and Stripe billing health.
function OpsTab() {
  return (
    <div className="space-y-4">
      <SelfDevManualCard />
      <NorthflankCard />
      <DbConsoleCard />
      <StripeHealthCard />
    </div>
  );
}

// "SELF-DEV & ADMIN MANUAL" (Rob, 2026-09-03) — an AI-written operator's
// guide to running Morpheus through Self-Dev and this Admin panel, generated
// from the ACTUAL CURRENT source of those two surfaces (server/src/functions/
// generateSelfDevManual.js), not hand-maintained prose. Regenerates two
// ways: the admin clicks REGENERATE here, or automatically right after any
// self-dev push that touches one of the files the manual is built from (see
// pushSelfDevToGithub.js) — either way `doc.trigger` records which happened,
// so "is this the latest?" is always visible without re-running the LLM call
// just to check. Same single-row-per-admin storage + PDF-rendering pattern
// as RebuildDocDialog.jsx (that dialog documents Morpheus's architecture for
// a rebuild; this one documents how to operate it day to day).
function SelfDevManualCard() {
  const [doc, setDoc] = useState(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await base44.entities.SelfDevManual.list('-created_date', 1);
      setDoc(list.length > 0 ? list[0] : null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const generate = async () => {
    setGenerating(true);
    setError(null);
    try {
      await base44.functions.invoke('generateSelfDevManual', {});
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setGenerating(false);
    }
  };

  const downloadMd = () => {
    if (!doc) return;
    if (doc.file_url) {
      const a = document.createElement('a');
      a.href = doc.file_url;
      a.download = `morpheus-self-dev-admin-manual-${doc.version || 'doc'}.md`;
      a.target = '_blank';
      a.click();
      return;
    }
    if (!doc.content) return;
    const blob = new Blob([doc.content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `morpheus-self-dev-admin-manual-${doc.version || 'doc'}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadPdf = async () => {
    if (!doc) return;
    setPdfLoading(true);
    setError(null);
    try {
      let md = doc.content || '';
      if (doc.file_url) {
        const res = await fetch(doc.file_url);
        md = await res.text();
      }

      const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
      const pageW = pdf.internal.pageSize.getWidth();
      const pageH = pdf.internal.pageSize.getHeight();
      const margin = 40;
      const maxW = pageW - margin * 2;
      let y = margin;

      const ensureSpace = (h) => {
        if (y + h > pageH - margin) { pdf.addPage(); y = margin; }
      };

      for (const rawLine of md.split('\n')) {
        const line = rawLine.trimEnd();

        if (line.startsWith('# ')) {
          ensureSpace(28);
          pdf.setFont('helvetica', 'bold');
          pdf.setFontSize(18);
          pdf.setTextColor(0, 180, 80);
          const wrapped = pdf.splitTextToSize(line.replace(/^# /, ''), maxW);
          for (const w of wrapped) { ensureSpace(22); pdf.text(w, margin, y); y += 22; }
          y += 6;
        } else if (line.startsWith('## ')) {
          ensureSpace(24);
          pdf.setFont('helvetica', 'bold');
          pdf.setFontSize(14);
          pdf.setTextColor(0, 140, 60);
          const wrapped = pdf.splitTextToSize(line.replace(/^## /, ''), maxW);
          for (const w of wrapped) { ensureSpace(18); pdf.text(w, margin, y); y += 18; }
          y += 4;
        } else if (line.startsWith('### ')) {
          ensureSpace(20);
          pdf.setFont('helvetica', 'bold');
          pdf.setFontSize(11);
          pdf.setTextColor(0, 120, 50);
          const wrapped = pdf.splitTextToSize(line.replace(/^### /, ''), maxW);
          for (const w of wrapped) { ensureSpace(15); pdf.text(w, margin, y); y += 15; }
          y += 2;
        } else if (line.startsWith('- ') || line.startsWith('* ')) {
          pdf.setFont('helvetica', 'normal');
          pdf.setFontSize(9);
          pdf.setTextColor(30, 30, 30);
          const wrapped = pdf.splitTextToSize('•  ' + line.replace(/^[-*]\s+/, ''), maxW - 10);
          for (const w of wrapped) { ensureSpace(13); pdf.text(w, margin + 10, y); y += 13; }
        } else if (line.trim() === '') {
          y += 6;
        } else {
          pdf.setFont('helvetica', 'normal');
          pdf.setFontSize(9);
          pdf.setTextColor(30, 30, 30);
          const wrapped = pdf.splitTextToSize(line, maxW);
          for (const w of wrapped) { ensureSpace(13); pdf.text(w, margin, y); y += 13; }
        }
      }

      pdf.save(`morpheus-self-dev-admin-manual-${(doc.version || 'manual').replace(/[:.]/g, '-')}.pdf`);
    } catch (e) {
      setError('PDF generation failed: ' + e.message);
    } finally {
      setPdfLoading(false);
    }
  };

  const sizeKb = doc?.content_size ? (doc.content_size / 1024).toFixed(1) : '0';
  const triggerLabel = doc?.trigger === 'auto:push' ? 'auto-updated after push' : doc?.trigger === 'manual' ? 'generated by hand' : null;

  return (
    <Card>
      <div className="flex items-center gap-2 text-xs text-primary/60 mb-1 tracking-wider">
        <FileText size={13} /> SELF-DEV &amp; ADMIN MANUAL
      </div>
      <p className="text-primary/50 text-xs mb-3 leading-relaxed">
        How to actually run Morpheus through Self-Dev and this Admin panel — written by AI directly from the current source of both, so it reflects what the code does right now. Re-generates automatically whenever a self-dev push changes one of the files it's built from; REGENERATE forces a fresh copy any time.
      </p>

      {loading && (
        <div className="flex items-center gap-2 text-primary/60 text-xs py-4 justify-center">
          <Loader2 size={14} className="animate-spin" /> Loading...
        </div>
      )}

      {error && <div className="text-red-500 text-xs border border-red-500/30 px-2 py-1.5 mb-3">{error}</div>}

      {!loading && doc && (
        <div className="flex items-center gap-2 text-xs text-primary/60 mb-3 flex-wrap">
          <CheckCircle2 size={14} className="text-primary" />
          <span className="text-primary">{new Date(doc.version).toLocaleString()}</span>
          <span className="text-primary/30">|</span>
          {sizeKb} KB
          {triggerLabel && (<><span className="text-primary/30">|</span><span>{triggerLabel}</span></>)}
        </div>
      )}

      {!loading && !doc && <div className="text-primary/40 text-xs italic mb-3">No manual generated yet. Press GENERATE to create one.</div>}

      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={generate}
          disabled={generating}
          className="flex items-center gap-1 px-3 py-1.5 border border-primary/50 text-primary/80 hover:border-primary hover:text-primary text-xs disabled:opacity-30"
        >
          {generating ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} {doc ? 'REGENERATE' : 'GENERATE'}
        </button>
        <button
          onClick={downloadMd}
          disabled={!doc}
          className="flex items-center gap-1 px-3 py-1.5 border border-primary/50 text-primary/80 hover:border-primary hover:text-primary text-xs disabled:opacity-30"
        >
          <Download size={13} /> DOWNLOAD .MD
        </button>
        <button
          onClick={downloadPdf}
          disabled={!doc || pdfLoading}
          className="flex items-center gap-1 px-3 py-1.5 border border-primary/50 text-primary/80 hover:border-primary hover:text-primary text-xs disabled:opacity-30"
        >
          {pdfLoading ? <Loader2 size={13} className="animate-spin" /> : <FileDown size={13} />} DOWNLOAD PDF
        </button>
      </div>
    </Card>
  );
}

function NorthflankCard() {
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState(null);
  const [logs, setLogs] = useState(null);
  const [search, setSearch] = useState('error');
  const [minutes, setMinutes] = useState(60);
  const [loading, setLoading] = useState(false);
  const [logsError, setLogsError] = useState(null);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await base44.admin.getNorthflankStatus());
    } catch (e) {
      setStatusError(e.message);
    }
  }, []);
  useEffect(() => { loadStatus(); }, [loadStatus]);

  const loadLogs = async () => {
    setLoading(true);
    setLogsError(null);
    try {
      const res = await base44.admin.getNorthflankLogs({ search, minutes, limit: 150 });
      if (res.configured === false) {
        setLogsError('Not configured — set NORTHFLANK_API_TOKEN (see server/.env.example).');
        setLogs([]);
      } else if (res.error) {
        setLogsError(res.error);
        setLogs([]);
      } else {
        setLogs(res.lines || []);
      }
    } catch (e) {
      setLogsError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const buildStatus = status?.service?.status?.build?.status;

  return (
    <Card>
      <div className="text-xs text-primary/60 mb-1 tracking-wider">PRODUCTION STATUS &amp; LOGS (NORTHFLANK)</div>
      {status && !status.configured && (
        <div className="text-yellow-500 text-xs border border-yellow-500/30 px-2 py-1.5 mb-3 leading-relaxed">
          Not configured. Create a read-only API token in Northflank (Team Settings → API → Tokens, RBAC role
          needs "View Services" + "View Observability" on this project only) and set it as
          <code className="mx-1 text-yellow-400">NORTHFLANK_API_TOKEN</code> in the backend's environment.
        </div>
      )}
      {statusError && <div className="text-red-500 text-xs mb-3">{statusError}</div>}
      {status?.configured && status.error && <div className="text-red-500 text-xs mb-3">{status.error}</div>}
      {status?.configured && status.service && (
        <div className="text-xs text-primary/70 mb-3">
          Build status: <span className="text-primary">{buildStatus || 'unknown'}</span>
          {status.service?.name && <> — {status.service.name}</>}
        </div>
      )}

      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="search text (e.g. error)"
          className="flex-1 min-w-[10rem] bg-black/30 border border-primary/20 px-2 py-1.5 text-xs text-primary focus:outline-none focus:border-primary/50"
        />
        <input
          type="number"
          value={minutes}
          onChange={(e) => setMinutes(e.target.value)}
          min={1}
          max={1440}
          className="w-20 bg-black/30 border border-primary/20 px-2 py-1.5 text-xs text-primary focus:outline-none focus:border-primary/50"
        />
        <span className="text-primary/40 text-xs">min</span>
        <button
          onClick={loadLogs}
          disabled={loading}
          className="flex items-center gap-1 px-3 py-1.5 border border-primary/50 text-primary/80 hover:border-primary hover:text-primary text-xs disabled:opacity-30"
        >
          {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} PULL LOGS
        </button>
      </div>
      {logsError && <div className="text-red-500 text-xs mb-2">{logsError}</div>}
      {logs && (
        <div className="max-h-80 overflow-y-auto scrollbar-matrix bg-black/40 border border-primary/10 p-2 font-mono text-[11px] text-primary/70 space-y-0.5">
          {logs.length === 0 && <div className="text-primary/40 italic">No matching log lines.</div>}
          {logs.map((l, i) => (
            <div key={i} className="whitespace-pre-wrap break-all">
              <span className="text-primary/40">{l.ts ? new Date(l.ts).toLocaleTimeString() : ''}</span> {l.log}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function DbConsoleCard() {
  const [sql, setSql] = useState('SELECT key, value FROM platform_settings ORDER BY key;');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const isWrite = /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql);

  const run = async (confirmed = false) => {
    if (isWrite && !confirmed) {
      setConfirmOpen(true);
      return;
    }
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      setResult(await base44.admin.runDbQuery(sql, confirmed));
    } catch (e) {
      setError(e.message);
    } finally {
      setRunning(false);
      setConfirmOpen(false);
    }
  };

  return (
    <Card>
      <div className="text-xs text-primary/60 mb-1 tracking-wider">DATABASE CONSOLE</div>
      <p className="text-primary/50 text-xs mb-3 leading-relaxed">
        Direct SQL against this deployment's own database. SELECT/WITH run immediately; INSERT/UPDATE/DELETE ask
        for confirmation first and are logged to the audit trail either way. Schema changes (DROP/ALTER/CREATE/
        TRUNCATE/...) aren't allowed here — that needs a real migration.
      </p>
      <textarea
        value={sql}
        onChange={(e) => setSql(e.target.value)}
        rows={4}
        spellCheck={false}
        className="w-full bg-black/30 border border-primary/20 px-2 py-1.5 text-xs text-primary font-mono focus:outline-none focus:border-primary/50 mb-2"
      />
      <div className="flex items-center gap-2 mb-3">
        <button
          onClick={() => run(false)}
          disabled={running || !sql.trim()}
          className={`flex items-center gap-1 px-3 py-1.5 border text-xs disabled:opacity-30 ${
            isWrite
              ? 'border-yellow-500/60 text-yellow-500 hover:bg-yellow-500/10'
              : 'border-primary/50 text-primary/80 hover:border-primary hover:text-primary'
          }`}
        >
          {running ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} {isWrite ? 'RUN (WRITE)' : 'RUN'}
        </button>
      </div>
      {error && <div className="text-red-500 text-xs border border-red-500/30 px-2 py-1.5 mb-3">{error}</div>}
      {result?.rows && (
        <div className="overflow-x-auto max-h-80 overflow-y-auto scrollbar-matrix border border-primary/10">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-primary/50 text-left border-b border-primary/10 sticky top-0 bg-background">
                {result.rows[0]
                  ? Object.keys(result.rows[0]).map((c) => <th key={c} className="py-1 px-2">{c}</th>)
                  : <th className="py-1 px-2">(no columns)</th>}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, i) => (
                <tr key={i} className="border-b border-primary/5 last:border-0">
                  {Object.values(row).map((v, j) => (
                    <td key={j} className="py-1 px-2 text-primary/70 whitespace-pre-wrap break-all">
                      {v === null ? <span className="text-primary/30 italic">null</span> : String(v)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="text-primary/40 text-[11px] px-2 py-1">
            {result.rowCount} row(s){result.truncated ? ' (truncated to 500)' : ''}
          </div>
        </div>
      )}
      {result?.rowsAffected !== undefined && (
        <div className="text-primary text-xs">{result.rowsAffected} row(s) affected.</div>
      )}

      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <div className="bg-background border border-yellow-500/40 max-w-lg w-full p-5">
            <div className="flex items-center gap-2 mb-3 text-yellow-500">
              <AlertTriangle size={18} />
              <span className="font-display tracking-wider">CONFIRM WRITE</span>
            </div>
            <pre className="text-primary/80 text-xs bg-black/40 border border-primary/10 p-2 mb-4 overflow-x-auto whitespace-pre-wrap break-all">{sql}</pre>
            <p className="text-primary/60 text-xs mb-4">This runs directly against production data and is logged to the audit trail. Are you sure?</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmOpen(false)} className="px-3 py-1.5 border border-primary/30 text-primary/70 hover:text-primary text-xs">
                CANCEL
              </button>
              <button
                onClick={() => run(true)}
                disabled={running}
                className="flex items-center gap-1 px-3 py-1.5 border border-yellow-500 bg-yellow-500/10 text-yellow-500 hover:bg-yellow-500/20 text-xs font-bold"
              >
                {running ? <Loader2 size={13} className="animate-spin" /> : null} RUN WRITE
              </button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

function StripeHealthCard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await base44.admin.getStripeHealth());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <Card>
        <div className="flex items-center gap-2 text-primary/60 text-xs py-4 justify-center">
          <Loader2 size={14} className="animate-spin" /> Loading...
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs text-primary/60 tracking-wider">BILLING HEALTH (STRIPE)</div>
        <button onClick={load} className="text-primary/50 hover:text-primary"><RefreshCw size={13} /></button>
      </div>
      {error && <div className="text-red-500 text-xs">{error}</div>}
      {data?.configured === false && <div className="text-primary/40 text-xs italic">Stripe not configured.</div>}
      {data?.configured && data.error && <div className="text-red-500 text-xs">{data.error}</div>}
      {data?.configured && data.balance && (
        <div className="text-xs text-primary/70 mb-2">
          Available: {(data.balance.available || []).map((b) => `${(b.amount / 100).toFixed(2)} ${b.currency.toUpperCase()}`).join(', ') || '—'}
        </div>
      )}
      {data?.configured && !data.error && (
        <div className={`text-xs mb-2 ${data.failedCount > 0 ? 'text-red-400' : 'text-primary/70'}`}>
          {data.failedCount} failed/disputed event(s) in the last 25.
        </div>
      )}
      {data?.recentEvents?.length > 0 && (
        <div className="max-h-40 overflow-y-auto scrollbar-matrix space-y-1">
          {data.recentEvents.slice(0, 10).map((e) => (
            <div key={e.id} className={`text-[11px] flex justify-between gap-2 ${e.failed ? 'text-red-400' : 'text-primary/50'}`}>
              <span className="truncate">{e.type}</span>
              <span className="shrink-0">{new Date(e.created * 1000).toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function AuditLogTab() {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await base44.admin.getAuditLog(100);
      setEntries(res.entries || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="flex items-center gap-2 text-primary/60 text-sm py-12 justify-center"><Loader2 size={16} className="animate-spin" /> Loading...</div>;
  if (error) return <div className="text-red-500 text-sm border border-red-500/30 px-3 py-2">{error}</div>;

  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs text-primary/60 tracking-wider">AUDIT LOG — LAST 100</div>
        <button onClick={load} className="text-primary/50 hover:text-primary"><RefreshCw size={13} /></button>
      </div>
      {entries.length === 0 && <div className="text-primary/40 text-xs italic py-4 text-center">No admin actions logged yet.</div>}
      <div className="space-y-2 max-h-[32rem] overflow-y-auto scrollbar-matrix">
        {entries.map((e) => (
          <div key={e.id} className="text-xs border-b border-primary/10 pb-2 last:border-0">
            <div className="flex items-center gap-2 text-primary/70">
              <span className="font-bold text-primary/85">{e.action}</span>
              <span className="text-primary/40">{new Date(e.created_date).toLocaleString()}</span>
              <span className="text-primary/40">— {e.admin?.email || 'unknown'}</span>
            </div>
            {e.details && <div className="text-primary/50 mt-1 break-all font-mono text-[11px]">{e.details}</div>}
          </div>
        ))}
      </div>
    </Card>
  );
}

export default function AdminPanel() {
  const [tab, setTab] = useState('overview');

  return (
    <div className="relative min-h-screen bg-background text-primary font-mono">
      <MatrixRain opacity={0.04} />
      <div className="relative z-10 max-w-4xl mx-auto px-6 py-12 safe-top">
        <div className="flex items-center justify-between mb-6 gap-3 flex-wrap">
          <Link to="/" className="inline-flex items-center gap-1.5 text-primary/60 hover:text-primary text-sm transition-colors">
            <ArrowLeft size={14} /> BACK
          </Link>
          <Link to="/self-dev" title="Self-Dev — chat with Morpheus to edit its own codebase, live preview, push to production" className="inline-flex items-center gap-1.5 text-primary/60 hover:text-primary text-sm border border-primary/30 hover:border-primary/60 px-3 py-1.5 transition-colors">
            <Cpu size={13} /> SELF-DEV
          </Link>
        </div>

        <div className="flex items-center gap-3 mb-2">
          <ShieldCheck size={24} className="text-primary neon-glow" />
          <h1 className="text-2xl md:text-3xl font-display tracking-widest neon-glow text-heading">ADMIN CONTROL PANEL</h1>
        </div>
        <p className="text-primary/60 text-sm mb-8">
          // Model/routing control, margin visibility, monitoring, general config, and the maintenance punch-list — all in one place. Every write below is logged to the audit trail.
        </p>

        <div className="flex flex-wrap gap-1 mb-6 border-b border-primary/20">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs tracking-wider border-b-2 transition-colors ${
                tab === id ? 'border-primary text-primary' : 'border-transparent text-primary/50 hover:text-primary/80'
              }`}
            >
              <Icon size={13} /> {label}
            </button>
          ))}
        </div>

        {tab === 'overview' && <OverviewTab />}
        {tab === 'models' && <ModelsTab />}
        {tab === 'settings' && <SettingsTab />}
        {tab === 'tasks' && <TasksTab />}
        {tab === 'ops' && <OpsTab />}
        {tab === 'audit' && <AuditLogTab />}
      </div>
    </div>
  );
}
