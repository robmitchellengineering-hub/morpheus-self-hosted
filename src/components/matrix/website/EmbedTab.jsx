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
  { id: 'seo', label: 'SEO' },
  { id: 'traffic', label: 'Traffic (indexing)' },
];
const HOST = typeof window !== 'undefined' ? window.location.origin : 'https://morpheus.nz';

function snippet(token, dock) {
  return `<script src="${HOST}/plugin.js" data-token="${token}"${dock ? ' data-dock="1"' : ''}></script>`;
}

export default function EmbedTab({ projectId, connected }) {
  const [tokens, setTokens] = useState(null);
  const [err, setErr] = useState(null);
  const [label, setLabel] = useState('');
  // Default to EVERY scope rather than chat/deploy/store. A token that cannot
  // render a tab is a tab the owner does not have: the previous default omitted
  // `seo`, so a freshly created dock silently had no SEO page and the only fix
  // was a new token and a new snippet on the site. Everything here is still
  // tickable off — the default should not be the thing that limits you.
  const [scopes, setScopes] = useState(ALL_SCOPES.map((s) => s.id));
  const [dock, setDock] = useState(true);
  const [creating, setCreating] = useState(false);
  const [fresh, setFresh] = useState(null); // { token } shown once
  const [copied, setCopied] = useState(null);
  // In-place scope editing. The token string is never reissued, so the snippet
  // already pasted on the owner's site keeps working — that is the whole reason
  // this exists. One editor at a time: `editing` is the token id, and opening
  // another discards the first one's unsaved selection.
  const [editing, setEditing] = useState(null);
  const [editScopes, setEditScopes] = useState([]);
  const [editOriginal, setEditOriginal] = useState([]);
  const [editErr, setEditErr] = useState(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);

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
    setCreating(true); setErr(null); setFresh(null); setNotice(null);
    try {
      const { data } = await base44.functions.invoke('createWidgetToken', { projectId, label: label.trim() || null, scopes });
      setFresh(data);
      setLabel('');
      load();
    } catch (e) { setErr(e?.data?.error || e.message); }
    finally { setCreating(false); }
  };

  const revoke = async (id) => {
    setErr(null); setNotice(null);
    if (editing === id) closeEditor();
    try {
      await base44.functions.invoke('revokeWidgetToken', { projectId, tokenId: id });
      load();
    } catch (e) { setErr(e?.data?.error || e.message); }
  };

  // Only known scopes are tickable; anything unknown stored on the row is
  // dropped (the server filters the same way before it saves).
  const knownScopes = (list) => (list || []).filter((s) => ALL_SCOPES.some((a) => a.id === s));

  const openEditor = (t) => {
    const current = knownScopes(t.scopes);
    setEditing(t.id);
    setEditScopes(current);
    setEditOriginal(current);
    setEditErr(null);
    setNotice(null);
  };

  const closeEditor = () => {
    setEditing(null);
    setEditScopes([]);
    setEditOriginal([]);
    setEditErr(null);
  };

  const toggleEditScope = (s) => setEditScopes((cur) => cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]);

  const sameScopes = (a, b) => [...a].sort().join(',') === [...b].sort().join(',');

  const saveScopes = async (id) => {
    // The button is disabled for an empty list; this guard means no empty list
    // can ever reach the server even if that changes.
    if (!editScopes.length) { setEditErr('Pick at least one scope.'); return; }
    setSaving(true); setEditErr(null); setNotice(null);
    try {
      const { data } = await base44.functions.invoke('updateWidgetToken', { projectId, tokenId: id, scopes: editScopes });
      const next = knownScopes(data?.scopes || editScopes);
      setTokens((cur) => (cur || []).map((t) => (t.id === id ? { ...t, scopes: next } : t)));
      closeEditor();
      setNotice('Scopes saved — the snippet already on your site keeps working.');
    } catch (e) {
      // Keep the editor open with the user's selection intact — changing it
      // here would make a retry guess at what they meant.
      setEditErr(e?.data?.error || e.message);
    } finally { setSaving(false); }
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
        <label className="flex items-start gap-2 text-[10px] cursor-pointer">
          <input type="checkbox" className="mt-0.5 accent-[color:var(--primary,#4f8cff)]"
            checked={dock} onChange={(e) => setDock(e.target.checked)} />
          <span className={dock ? 'text-primary/70' : 'text-primary/40'}>
            Floating widget — a small button in the corner that opens the panel over the page, instead of sitting inline on one page.
            {dock && ' Put the snippet where it loads for you only (e.g. a PHP snippet gated to logged-in admins) — it carries the token, so anyone the page sends it to can act as you.'}
          </span>
        </label>
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
            <code className="flex-1 text-[10px] bg-black/40 border border-primary/20 px-2 py-1.5 text-primary/80 break-all">{snippet(fresh.token, dock)}</code>
            <button onClick={() => copy(snippet(fresh.token, dock), 'snip')} className="text-primary/50 hover:text-primary shrink-0">
              {copied === 'snip' ? <Check size={13} /> : <Copy size={13} />}
            </button>
          </div>
        </div>
      )}

      {/* list */}
      <div className="space-y-1.5">
        <div className="text-[10px] text-primary/40 uppercase tracking-wider">Tokens</div>
        {notice && <div className="text-[10px] text-primary/70 border border-primary/15 bg-primary/5 px-3 py-2">{notice}</div>}
        {tokens == null && <div className="text-[11px] text-primary/40 flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> loading…</div>}
        {tokens?.length === 0 && <div className="text-[11px] text-primary/40">None yet.</div>}
        {(tokens || []).map((t) => {
          const open = editing === t.id;
          const dirty = open && !sameScopes(editScopes, editOriginal);
          const canSave = dirty && editScopes.length > 0 && !saving;
          // Explains whichever disabled control is on screen — an empty list and
          // an unchanged selection are both refused, and a save in flight is the
          // only reason CANCEL is held.
          const hint = saving ? 'Saving…' : (!editScopes.length ? 'Pick at least one scope.' : (!dirty ? 'Tick a scope to enable saving.' : null));
          return (
            <div key={t.id} className={`border ${t.revoked ? 'border-primary/10' : 'border-primary/15'}`}>
              <div className={`px-3 py-2 flex items-center justify-between gap-2 ${t.revoked ? 'opacity-50' : ''}`}>
                <div className="min-w-0">
                  <div className="text-[11px] text-primary/80 truncate">{t.label || 'unlabelled'} {t.revoked && <span className="text-red-400/70">· revoked</span>}</div>
                  <div className="text-[9px] text-primary/35 font-mono">{t.prefix}… · {t.scopes.join(' · ')}{t.last_used_at ? ' · used' : ' · never used'}</div>
                </div>
                {!t.revoked && (
                  <div className="flex items-center gap-2 shrink-0">
                    <button onClick={() => (open ? closeEditor() : openEditor(t))}
                      className={`text-[9px] px-1.5 py-0.5 border ${open ? 'text-primary border-primary/60 bg-primary/10' : 'text-primary/50 border-primary/15'}`}>
                      EDIT SCOPES
                    </button>
                    <button onClick={() => revoke(t.id)} className="text-primary/30 hover:text-red-400" title="Revoke">
                      <Trash2 size={12} />
                    </button>
                  </div>
                )}
              </div>

              {t.revoked && (
                <div className="px-3 pb-2 text-[9px] text-primary/40">Revoked — its scopes can no longer be changed.</div>
              )}

              {open && !t.revoked && (
                <div className="px-3 pb-3 pt-2 border-t border-primary/15 space-y-2">
                  <div className="text-[9px] text-primary/35">This keeps the same token, so the snippet already pasted on your site keeps working.</div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1.5">
                    {ALL_SCOPES.map((s) => (
                      <label key={s.id} className="flex items-center gap-1.5 text-[10px] cursor-pointer">
                        <input type="checkbox" className="accent-[color:var(--primary,#4f8cff)]"
                          checked={editScopes.includes(s.id)} onChange={() => toggleEditScope(s.id)} />
                        <span className={editScopes.includes(s.id) ? 'text-primary/70' : 'text-primary/40'}>{s.label}</span>
                      </label>
                    ))}
                  </div>
                  {editErr && <div className="text-red-400 text-[10px] border border-red-500/30 px-2 py-1.5">{editErr}</div>}
                  {hint && <div className="text-[9px] text-primary/35">{hint}</div>}
                  <div className="flex items-center gap-2">
                    <button onClick={() => saveScopes(t.id)} disabled={!canSave}
                      className="flex items-center justify-center gap-1.5 h-[32px] px-3 bg-primary text-black font-bold text-[10px] hover:bg-[#39ff14] disabled:opacity-40">
                      {saving ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />} SAVE SCOPES
                    </button>
                    <button onClick={closeEditor} disabled={saving}
                      className="h-[32px] px-3 border border-primary/15 text-primary/50 text-[10px] hover:text-primary disabled:opacity-40">
                      CANCEL
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
