import { useState, useEffect, useCallback } from 'react';
import { Loader2, Plus, Copy, Check, Trash2, Code } from 'lucide-react';
import { base44 } from '@/api/base44Client';

// EMBED tab of the WEBSITE panel — mint a scoped widget token and copy the
// <script> snippet that drops a Morpheus surface onto the owner's own site.
// The token pins one project + a fixed set of scopes; only its hash is
// stored, so the full value is shown exactly once, right after you create it.

const ALL_SCOPES = [
  { id: 'chat', label: 'Chat (discuss)' },
  { id: 'deploy', label: 'Deploy code' },
  { id: 'store', label: 'Shop & pages' },
];
const HOST = typeof window !== 'undefined' ? window.location.origin : 'https://morpheus.nz';

function snippet(token) {
  return `<script src="${HOST}/plugin.js" data-token="${token}"></script>`;
}

export default function EmbedTab({ projectId, connected }) {
  const [tokens, setTokens] = useState(null);
  const [err, setErr] = useState(null);
  const [label, setLabel] = useState('');
  const [scopes, setScopes] = useState(['chat', 'deploy', 'store']);
  const [creating, setCreating] = useState(false);
  const [fresh, setFresh] = useState(null); // { token } shown once
  const [copied, setCopied] = useState(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const { data } = await base44.functions.invoke('listWidgetTokens', { projectId });
      setTokens(data.tokens || []);
    } catch (e) { setErr(e?.data?.error || e.message); }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const toggle = (s) => setScopes((cur) => cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]);

  const create = async () => {
    if (!scopes.length) { setErr('Pick at least one scope.'); return; }
    setCreating(true); setErr(null); setFresh(null);
    try {
      const { data } = await base44.functions.invoke('createWidgetToken', { projectId, label: label.trim() || null, scopes });
      setFresh(data);
      setLabel('');
      load();
    } catch (e) { setErr(e?.data?.error || e.message); }
    finally { setCreating(false); }
  };

  const revoke = async (id) => {
    setErr(null);
    try {
      await base44.functions.invoke('revokeWidgetToken', { projectId, tokenId: id });
      load();
    } catch (e) { setErr(e?.data?.error || e.message); }
  };

  const copy = async (text, key) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    } catch { /* clipboard blocked — the field is selectable */ }
  };

  return (
    <div className="p-4 space-y-5">
      <p className="text-[11px] text-primary/50 leading-relaxed">
        Put a Morpheus panel on your own site. Each token is scoped to this project and the actions you pick — and acts as you, so treat it like a password.
      </p>

      {err && <div className="text-red-400 text-[11px] border border-red-500/30 px-3 py-2">{err}</div>}
      {!connected && (
        <div className="text-[11px] text-yellow-500/80 border border-yellow-500/30 px-3 py-2">
          Connect your site in Setup first — the embed’s Deploy and Shop tabs need the connection.
        </div>
      )}

      {/* create */}
      <div className="border border-primary/20 p-3 space-y-3">
        <div className="text-[10px] text-primary/40 uppercase tracking-wider">New token</div>
        <input
          className="w-full bg-black/30 border border-primary/20 px-2.5 h-[38px] text-[12px] text-primary focus:outline-none focus:border-primary/50"
          placeholder="label (e.g. “storefront footer”)" value={label} onChange={(e) => setLabel(e.target.value)} />
        <div className="flex flex-wrap gap-2">
          {ALL_SCOPES.map((s) => (
            <button key={s.id} onClick={() => toggle(s.id)}
              className={`text-[10px] px-2 py-1 border ${scopes.includes(s.id) ? 'text-primary border-primary/60 bg-primary/10' : 'text-primary/40 border-primary/20'}`}>
              {s.label}
            </button>
          ))}
        </div>
        <button onClick={create} disabled={creating}
          className="w-full flex items-center justify-center gap-1.5 h-[40px] bg-primary text-black font-bold text-[12px] hover:bg-[#39ff14] disabled:opacity-40">
          {creating ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} CREATE TOKEN
        </button>
      </div>

      {fresh && (
        <div className="border border-primary/40 bg-primary/5 p-3 space-y-2">
          <div className="text-[11px] text-primary font-bold">Copy this now — it won’t be shown again.</div>
          <div className="text-[10px] text-primary/60">Token</div>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-[10px] bg-black/40 border border-primary/20 px-2 py-1.5 text-primary/80 break-all">{fresh.token}</code>
            <button onClick={() => copy(fresh.token, 'tok')} className="text-primary/50 hover:text-primary shrink-0">
              {copied === 'tok' ? <Check size={13} /> : <Copy size={13} />}
            </button>
          </div>
          <div className="text-[10px] text-primary/60 flex items-center gap-1"><Code size={10} /> Embed snippet</div>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-[10px] bg-black/40 border border-primary/20 px-2 py-1.5 text-primary/80 break-all">{snippet(fresh.token)}</code>
            <button onClick={() => copy(snippet(fresh.token), 'snip')} className="text-primary/50 hover:text-primary shrink-0">
              {copied === 'snip' ? <Check size={13} /> : <Copy size={13} />}
            </button>
          </div>
        </div>
      )}

      {/* list */}
      <div className="space-y-1.5">
        <div className="text-[10px] text-primary/40 uppercase tracking-wider">Tokens</div>
        {tokens == null && <div className="text-[11px] text-primary/40 flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> loading…</div>}
        {tokens?.length === 0 && <div className="text-[11px] text-primary/40">None yet.</div>}
        {(tokens || []).map((t) => (
          <div key={t.id} className={`border px-3 py-2 flex items-center justify-between gap-2 ${t.revoked ? 'border-primary/10 opacity-50' : 'border-primary/15'}`}>
            <div className="min-w-0">
              <div className="text-[11px] text-primary/80 truncate">{t.label || 'unlabelled'} {t.revoked && <span className="text-red-400/70">· revoked</span>}</div>
              <div className="text-[9px] text-primary/35 font-mono">{t.prefix}… · {t.scopes.join(' · ')}{t.last_used_at ? ' · used' : ' · never used'}</div>
            </div>
            {!t.revoked && (
              <button onClick={() => revoke(t.id)} className="text-primary/30 hover:text-red-400 shrink-0" title="Revoke">
                <Trash2 size={12} />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
