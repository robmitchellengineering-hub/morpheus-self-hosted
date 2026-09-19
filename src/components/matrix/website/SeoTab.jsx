import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Loader2, RefreshCw, Check, ExternalLink, ChevronLeft, Wand2, Search, AlertTriangle,
  FileText, Plus, Save, X, Sparkles, Eye,
} from 'lucide-react';
import { base44 } from '@/api/base44Client';

// SEO tab of the WEBSITE panel — every SEO field on every page, post and
// product on the operator's own site, operable from here, plus AI generation
// for the ones that have nothing set.
//
// Two facts drive the whole design, and both are reported by the plugin rather
// than assumed here:
//
//   * WHO OWNS THE HEAD. With no third-party SEO plugin, Morpheus emits the
//     title/description/canonical/OG/schema tags itself. With Yoast, Rank Math,
//     AIOSEO or SEOPress active, Morpheus drives THAT plugin's own fields so
//     two plugins never emit competing tags. The same controls work either way;
//     the banner says which is happening, because "who is producing this tag"
//     is the first thing the operator needs to know when a title doesn't change.
//   * GENERATION PROPOSES, THE OPERATOR DISPOSES. Generated titles and
//     descriptions go straight into search results, so a batch is reviewed
//     field-by-field before anything is written. Nothing is published by AI
//     without a tap.

const inputCls = 'w-full bg-black/30 border border-primary/20 px-2.5 h-[38px] text-[12px] text-primary focus:outline-none focus:border-primary/50';
const areaCls = 'w-full bg-black/30 border border-primary/20 px-2.5 py-2 text-[12px] text-primary focus:outline-none focus:border-primary/50';
const DEFAULT_LIMITS = { title_min: 15, title_max: 60, desc_min: 70, desc_max: 160 };

const call = (projectId, action, data) =>
  base44.functions.invoke('wordPressSeoAction', { projectId, action, data }).then((r) => r.data);

function Btn({ onClick, disabled, children, kind = 'ghost', title }) {
  const cls = kind === 'primary'
    ? 'bg-primary text-black font-bold hover:bg-[#39ff14]'
    : kind === 'danger'
      ? 'border border-red-500/30 text-red-400/80 hover:border-red-500/60 hover:text-red-400'
      : 'border border-primary/30 text-primary/75 hover:border-primary hover:text-primary';
  return (
    <button onClick={onClick} disabled={disabled} title={title}
      className={`h-[38px] px-3 text-[11px] disabled:opacity-40 flex items-center justify-center gap-1.5 shrink-0 ${cls}`}>
      {children}
    </button>
  );
}

function Counter({ value, min, max }) {
  const n = (value || '').length;
  const state = n === 0 ? 'text-primary/30' : n > max ? 'text-red-400' : n < min ? 'text-yellow-500/80' : 'text-primary/60';
  return <span className={`text-[9px] ${state}`}>{n}/{max}</span>;
}

function Field({ label, hint, right, children }) {
  return (
    <label className="block">
      <div className="flex items-center justify-between mb-1 gap-2">
        <span className="text-[10px] text-primary/45 uppercase tracking-wider">{label}</span>
        {right}
      </div>
      {children}
      {hint && <div className="text-[9px] text-primary/35 mt-0.5">{hint}</div>}
    </label>
  );
}

/** One proposal, as generated. Warnings are shown, never silently fixed. */
function SuggestionRow({ s, checked, onToggle }) {
  return (
    <div className={`border px-3 py-2.5 ${checked ? 'border-primary/40 bg-primary/5' : 'border-primary/15 opacity-60'}`}>
      <div className="flex items-start gap-2">
        <button onClick={onToggle} className="mt-0.5 shrink-0"
          title={checked ? 'Skip this one' : 'Include this one'}>
          <span className={`w-[15px] h-[15px] border flex items-center justify-center ${checked ? 'border-primary bg-primary/20 text-primary' : 'border-primary/30 text-transparent'}`}>
            <Check size={11} />
          </span>
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-primary/85 truncate">{s.title || `#${s.id}`}</span>
            {s.type && <span className="text-[9px] text-primary/35 uppercase shrink-0">{s.type}</span>}
            {!s.grounded && <span className="text-[9px] text-yellow-500/70 shrink-0" title="Only the title was read — the model did not see the page text.">title-only</span>}
          </div>
          <div className="text-[11px] text-primary mt-1 break-words">{s.seo_title}</div>
          <div className="text-[10px] text-primary/60 mt-0.5 break-words">{s.seo_description}</div>
          {s.focus_keyword && <div className="text-[9px] text-primary/40 mt-0.5">keyword: {s.focus_keyword}</div>}
          {s.warnings?.length > 0 && (
            <div className="mt-1 text-[9px] text-yellow-500/80 flex items-start gap-1">
              <AlertTriangle size={9} className="mt-[2px] shrink-0" />
              <span>{s.warnings.join(' · ')}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function SeoTab({ projectId, store }) {
  const [view, setView] = useState('list'); // list | item | blog
  const [ctx, setCtx] = useState(null);
  const [items, setItems] = useState(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);

  const [audit, setAudit] = useState(null); // { issues, counts, scanned }
  const [auditing, setAuditing] = useState(false);

  const [edit, setEdit] = useState(null); // the item being edited + form
  const [saving, setSaving] = useState(false);
  const [genOne, setGenOne] = useState(false);

  const [batch, setBatch] = useState(null); // { suggestions, ... } pending review
  const [genBatch, setGenBatch] = useState(false);
  const [applying, setApplying] = useState(false);

  const [blog, setBlog] = useState(null); // { form fields } | { draft }
  const [genBlog, setGenBlog] = useState(false);
  const [posting, setPosting] = useState(false);

  const limits = ctx?.limits || DEFAULT_LIMITS;
  const issuesById = useMemo(() => {
    const m = {};
    for (const i of audit?.issues || []) m[i.id] = [...(m[i.id] || []), i];
    return m;
  }, [audit]);

  const load = useCallback(async (opts = {}) => {
    setLoading(true); setErr(null);
    try {
      const [c, list] = await Promise.all([
        call(projectId, 'context', {}),
        call(projectId, 'list_content', { limit: 60, search: (opts.search ?? search).trim() || undefined }),
      ]);
      if (c?.ok === false || list?.ok === false) throw new Error(c?.message || list?.message || 'The site rejected the request.');
      setCtx(c); setItems(list?.items || []);
    } catch (e) { setErr(e?.data?.error || e.message); }
    finally { setLoading(false); }
  }, [projectId, search]);

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [projectId]);

  const runAudit = async () => {
    setAuditing(true); setErr(null);
    try {
      const a = await call(projectId, 'audit', { limit: 100 });
      if (a?.ok === false) throw new Error(a.message || 'The site rejected the audit.');
      setAudit(a);
      setNote(a.issues?.length
        ? `${a.issues.length} issue${a.issues.length === 1 ? '' : 's'} across ${a.scanned} item${a.scanned === 1 ? '' : 's'}.`
        : `Nothing to fix across ${a.scanned} item${a.scanned === 1 ? '' : 's'}.`);
    } catch (e) { setErr(e?.data?.error || e.message); }
    finally { setAuditing(false); }
  };

  const openItem = (it) => {
    setErr(null); setNote(null); setBatch(null); setGenOne(false);
    setEdit({
      id: it.id, title: it.title, type: it.type, url: it.url, status: it.status,
      form: {
        seo_title: it.seo_title || '',
        seo_description: it.seo_description || '',
        focus_keyword: it.focus_keyword || '',
        canonical: '',
        og_image: '',
        noindex: !!it.noindex,
      },
      suggestion: null,
    });
    setView('item');
    // The list row only carries the list fields; the full record (canonical,
    // og:image) comes from get_seo so nothing is shown as empty when it isn't.
    call(projectId, 'get_seo', { id: it.id }).then((r) => {
      const f = r?.item;
      if (!f) return;
      setEdit((cur) => cur && cur.id === it.id ? {
        ...cur,
        form: {
          seo_title: f.seo_title || '',
          seo_description: f.seo_description || '',
          focus_keyword: f.focus_keyword || '',
          canonical: f.canonical || '',
          og_image: f.og_image || '',
          noindex: !!f.noindex,
        },
        effective_title: f.effective_title,
        effective_description: f.effective_description,
        edit_url: f.edit_url || null,
      } : cur);
    }).catch(() => { /* the form still works with what the list gave us */ });
  };

  const save = async () => {
    setSaving(true); setErr(null); setNote(null);
    try {
      const r = await call(projectId, 'set_seo', { id: edit.id, ...edit.form });
      if (r?.ok === false) throw new Error(r.message || 'The site rejected the change.');
      setNote('Saved.');
      setItems(null);
      setAudit(null); // the audit is now stale — a stale issue list is worse than none
      const list = await call(projectId, 'list_content', { limit: 60 });
      setItems(list?.items || []);
    } catch (e) { setErr(e?.data?.error || e.message); }
    finally { setSaving(false); }
  };

  const generateOne = async () => {
    setGenOne(true); setErr(null); setNote(null);
    try {
      const r = await base44.functions.invoke('generateSeoMeta', { projectId, items: [{ id: edit.id }] }).then((x) => x.data);
      const s = r?.suggestions?.[0];
      if (!s) throw new Error('No suggestion came back — try again.');
      setEdit((cur) => ({ ...cur, suggestion: s }));
      if (r.title_only) setNote('Only the title was available to read — check the suggestion against the page before saving.');
    } catch (e) { setErr(e?.data?.error || e.message); }
    finally { setGenOne(false); }
  };

  // The batch targets content a human would target: published, and missing
  // either half of its metadata. Rewriting a title someone deliberately wrote
  // is not "fixing" anything.
  const missing = useMemo(
    () => (items || []).filter((it) => it.status === 'publish' && (!it.seo_title || !it.seo_description)),
    [items],
  );

  const generateBatch = async () => {
    if (missing.length === 0) { setNote('Every published item already has a title and a description.'); return; }
    setGenBatch(true); setErr(null); setNote(null); setBatch(null);
    try {
      const r = await base44.functions.invoke('generateSeoMeta', {
        projectId, items: missing.slice(0, 25).map((it) => ({ id: it.id })),
      }).then((x) => x.data);
      setBatch({ ...r, checked: Object.fromEntries((r.suggestions || []).map((s) => [s.id, true])) });
    } catch (e) { setErr(e?.data?.error || e.message); }
    finally { setGenBatch(false); }
  };

  const applyBatch = async () => {
    const chosen = (batch?.suggestions || []).filter((s) => batch.checked[s.id]);
    if (chosen.length === 0) return;
    setApplying(true); setErr(null); setNote(null);
    try {
      const r = await call(projectId, 'bulk_set_seo', {
        items: chosen.map((s) => ({ id: s.id, seo_title: s.seo_title, seo_description: s.seo_description, focus_keyword: s.focus_keyword })),
      });
      if (r?.ok === false) throw new Error(r.message || 'The site rejected the change.');
      const failed = r?.failed?.length || 0;
      setNote(`Applied to ${r?.count ?? chosen.length} item${(r?.count ?? chosen.length) === 1 ? '' : 's'}${failed ? ` — ${failed} failed` : ''}.`);
      setBatch(null); setAudit(null);
      const list = await call(projectId, 'list_content', { limit: 60 });
      setItems(list?.items || []);
    } catch (e) { setErr(e?.data?.error || e.message); }
    finally { setApplying(false); }
  };

  const createBlog = async () => {
    setPosting(true); setErr(null); setNote(null);
    try {
      const d = blog.draft;
      const created = await base44.functions.invoke('wordPressStoreAction', {
        projectId, action: 'create_post',
        data: { title: d.title, content: d.content, excerpt: d.excerpt, status: 'draft' },
      }).then((x) => x.data);
      if (created?.ok === false) throw new Error(created.message || 'The site rejected the post.');
      const postId = created?.post?.id;
      if (postId) {
        await call(projectId, 'set_seo', {
          id: postId, seo_title: d.seo_title, seo_description: d.seo_description, focus_keyword: d.focus_keyword,
        });
      }
      setBlog({ ...blog, created: created?.post, draft: null });
      setItems(null); setAudit(null);
      const list = await call(projectId, 'list_content', { limit: 60 });
      setItems(list?.items || []);
      setNote('Saved as a DRAFT on your site — nothing is public until you publish it.');
    } catch (e) { setErr(e?.data?.error || e.message); }
    finally { setPosting(false); }
  };

  const generateBlog = async () => {
    setGenBlog(true); setErr(null); setNote(null);
    try {
      const r = await base44.functions.invoke('generateBlogPost', { projectId, ...blog.form }).then((x) => x.data);
      if (!r?.draft) throw new Error('No draft came back — try again.');
      setBlog({ form: blog.form, draft: r.draft, warnings: r.warnings, linkable: r.linkable });
    } catch (e) { setErr(e?.data?.error || e.message); }
    finally { setGenBlog(false); }
  };

  // ── not available on this site's plugin build ────────────────────────────
  if (store && store.connected && store.seo_available === false) {
    return (
      <div className="p-4 space-y-2">
        <div className="text-[12px] text-yellow-500/85 border border-yellow-500/30 px-3 py-2 leading-relaxed">
          This site is running the Morpheus plugin version {store.version || 'older than 0.5'} — it doesn't have the SEO module yet.
        </div>
        <div className="text-[11px] text-primary/55 leading-relaxed">
          Reinstall the plugin from the SETUP tab and the SEO tab appears. Your connection and settings are kept.
        </div>
      </div>
    );
  }

  // ── header, shared by the list and the item view ──────────────────────────
  const ownerLine = ctx
    ? ctx.owns_head
      ? 'Morpheus writes the title and description tags for this site.'
      : `${ctx.active_plugin === 'yoast' ? 'Yoast' : ctx.active_plugin === 'rankmath' ? 'Rank Math' : ctx.active_plugin === 'aioseo' ? 'All in One SEO' : ctx.active_plugin === 'seopress' ? 'SEOPress' : ctx.active_plugin} is active, so these fields are written into its own settings — nothing is emitted twice.`
    : null;

  if (view === 'item' && edit) {
    const f = edit.form;
    const set = (k, v) => setEdit((cur) => ({ ...cur, form: { ...cur.form, [k]: v } }));
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 border-b border-primary/15 shrink-0 h-[40px] px-3">
          <button onClick={() => { setView('list'); setEdit(null); setNote(null); setErr(null); }}
            className="flex items-center gap-1 text-[11px] text-primary/60 hover:text-primary">
            <ChevronLeft size={14} /> SEO
          </button>
          <span className="text-[11px] text-primary/80 truncate ml-1">{edit.title || `#${edit.id}`}</span>
          {edit.status && (
            <span className={`ml-auto text-[9px] uppercase px-1.5 py-0.5 border shrink-0 ${edit.status === 'publish' ? 'text-primary border-primary/50' : 'text-yellow-500/80 border-yellow-500/40'}`}>
              {edit.status === 'publish' ? 'live' : edit.status}
            </span>
          )}
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-matrix p-3 space-y-3">
          {err && <div className="text-red-400 text-[11px] border border-red-500/30 px-3 py-2">{err}</div>}
          {note && <div className="text-primary/80 text-[11px] border border-primary/40 bg-primary/5 px-3 py-2">{note}</div>}

          {(issuesById[edit.id] || []).length > 0 && (
            <div className="border border-yellow-500/30 px-3 py-2 space-y-1">
              <div className="text-[9px] text-yellow-500/85 uppercase tracking-wider">What the audit found here</div>
              {(issuesById[edit.id] || []).map((i, n) => (
                <div key={n} className="text-[10px] text-primary/70 flex items-start gap-1.5">
                  <span className={`uppercase text-[9px] shrink-0 ${i.severity === 'high' ? 'text-red-400' : i.severity === 'medium' ? 'text-yellow-500/85' : 'text-primary/40'}`}>{i.severity}</span>
                  <span>{i.message}</span>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2">
            {edit.url && (
              <a href={edit.url} target="_blank" rel="noreferrer" className="text-[10px] text-primary/50 hover:text-primary flex items-center gap-1">
                <ExternalLink size={10} /> view on site
              </a>
            )}
            {edit.edit_url && (
              <a href={edit.edit_url} target="_blank" rel="noreferrer" className="text-[10px] text-primary/50 hover:text-primary flex items-center gap-1">
                <ExternalLink size={10} /> edit in WordPress
              </a>
            )}
            <button onClick={generateOne} disabled={genOne}
              className="ml-auto h-[32px] px-2.5 text-[10px] border border-primary/40 text-primary hover:border-primary disabled:opacity-40 flex items-center gap-1.5">
              {genOne ? <Loader2 size={11} className="animate-spin" /> : <Wand2 size={11} />} WRITE IT FOR ME
            </button>
          </div>

          {edit.suggestion && (
            <div className="border border-primary/40 bg-primary/5 p-3 space-y-2">
              <div className="flex items-center gap-1.5 text-[10px] text-primary/60 uppercase tracking-wider">
                <Sparkles size={10} /> suggestion
              </div>
              <SuggestionRow s={edit.suggestion} checked onToggle={() => {}} />
              <div className="flex items-center gap-2">
                <Btn kind="primary" onClick={() => {
                  const s = edit.suggestion;
                  setEdit((cur) => ({
                    ...cur,
                    suggestion: null,
                    form: { ...cur.form, seo_title: s.seo_title, seo_description: s.seo_description, focus_keyword: s.focus_keyword || cur.form.focus_keyword },
                  }));
                  setNote('Loaded into the fields below — read it, then SAVE.');
                }}>
                  <Check size={12} /> USE THIS
                </Btn>
                <Btn onClick={() => setEdit((cur) => ({ ...cur, suggestion: null }))}>
                  <X size={12} /> Discard
                </Btn>
              </div>
            </div>
          )}

          <Field label="SEO title" right={<Counter value={f.seo_title} min={limits.title_min} max={limits.title_max} />}
            hint="what appears as the clickable headline in search results — the site name is added for you">
            <input className={inputCls} value={f.seo_title} onChange={(e) => set('seo_title', e.target.value)} />
          </Field>
          {!f.seo_title && edit.effective_title && (
            <div className="text-[9px] text-primary/35 -mt-2">Currently search sees: “{edit.effective_title}”</div>
          )}

          <Field label="Meta description" right={<Counter value={f.seo_description} min={limits.desc_min} max={limits.desc_max} />}
            hint="the blurb under the headline — it doesn't change your ranking, it decides whether people click">
            <textarea className={areaCls} rows={3} value={f.seo_description} onChange={(e) => set('seo_description', e.target.value)} />
          </Field>

          <Field label="Focus keyword" hint="the phrase you want this page found for — used by the audit to check it appears in the title">
            <input className={inputCls} value={f.focus_keyword} onChange={(e) => set('focus_keyword', e.target.value)} />
          </Field>

          <Field label="Canonical URL" hint="leave empty unless this content is duplicated elsewhere — then point it at the one true version">
            <input className={inputCls} value={f.canonical} onChange={(e) => set('canonical', e.target.value)} placeholder={edit.url || 'https://…'} />
          </Field>

          <Field label="Social share image" hint="the picture shown when the page is shared — 1200×630 works everywhere">
            <input className={inputCls} value={f.og_image} onChange={(e) => set('og_image', e.target.value)} placeholder="https://…" />
          </Field>

          <label className="flex items-start gap-2 border border-primary/15 px-3 py-2.5 cursor-pointer">
            <input type="checkbox" className="mt-0.5 accent-[color:var(--primary,#4f8cff)]"
              checked={f.noindex} onChange={(e) => set('noindex', e.target.checked)} />
            <span className="text-[11px] leading-relaxed">
              <span className={f.noindex ? 'text-yellow-500/90' : 'text-primary/70'}>Keep this out of search results (noindex)</span>
              <span className="block text-[9px] text-primary/40 mt-0.5">
                Use for a thank-you page, a test page, or anything you don't want strangers landing on. It stays live on the site — it just stops being listed.
              </span>
            </span>
          </label>
        </div>

        <div className="p-3 border-t border-primary/20 shrink-0 flex items-center gap-2">
          <Btn kind="primary" onClick={save} disabled={saving}>
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} SAVE SEO
          </Btn>
        </div>
      </div>
    );
  }

  if (view === 'blog') {
    const b = blog || { form: { topic: '', keywords: '', tone: '', words: 700 } };
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 border-b border-primary/15 shrink-0 h-[40px] px-3">
          <button onClick={() => { setView('list'); setBlog(null); setNote(null); setErr(null); }}
            className="flex items-center gap-1 text-[11px] text-primary/60 hover:text-primary">
            <ChevronLeft size={14} /> SEO
          </button>
          <span className="text-[11px] text-primary/80 ml-1">New blog post</span>
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-matrix p-3 space-y-3">
          {err && <div className="text-red-400 text-[11px] border border-red-500/30 px-3 py-2">{err}</div>}
          {note && <div className="text-primary/80 text-[11px] border border-primary/40 bg-primary/5 px-3 py-2">{note}</div>}

          {!b.draft && !b.created && (
            <>
              <p className="text-[11px] text-primary/50 leading-relaxed">
                Morpheus writes the post using your business profile and links to pages you already have. It lands as a
                <span className="text-primary/75"> draft</span> — you read it before it goes public.
              </p>
              <Field label="Topic" hint="leave empty and it picks the most useful thing your business could publish">
                <input className={inputCls} value={b.form.topic} onChange={(e) => setBlog({ ...b, form: { ...b.form, topic: e.target.value } })} />
              </Field>
              <Field label="Target phrases" hint="optional — comma separated, used naturally">
                <input className={inputCls} value={b.form.keywords} onChange={(e) => setBlog({ ...b, form: { ...b.form, keywords: e.target.value } })} />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Tone">
                  <input className={inputCls} value={b.form.tone} onChange={(e) => setBlog({ ...b, form: { ...b.form, tone: e.target.value } })} placeholder="plain, expert" />
                </Field>
                <Field label="Length (words)">
                  <input type="number" min={300} max={1500} step={50} className={inputCls}
                    value={b.form.words} onChange={(e) => setBlog({ ...b, form: { ...b.form, words: Number(e.target.value) } })} />
                </Field>
              </div>
            </>
          )}

          {b.draft && (
            <>
              <div className="text-[9px] text-primary/40 uppercase tracking-wider flex items-center gap-1.5">
                <Eye size={10} /> draft — edit anything before saving
              </div>
              <Field label="Title">
                <input className={inputCls} value={b.draft.title} onChange={(e) => setBlog({ ...b, draft: { ...b.draft, title: e.target.value } })} />
              </Field>
              <Field label="Excerpt">
                <textarea className={areaCls} rows={2} value={b.draft.excerpt} onChange={(e) => setBlog({ ...b, draft: { ...b.draft, excerpt: e.target.value } })} />
              </Field>
              <Field label="Body (HTML)" hint="basic tags — headings, paragraphs, lists, links">
                <textarea className={areaCls} rows={14} value={b.draft.content} onChange={(e) => setBlog({ ...b, draft: { ...b.draft, content: e.target.value } })} />
              </Field>
              <Field label="SEO title" right={<Counter value={b.draft.seo_title} min={limits.title_min} max={limits.title_max} />}>
                <input className={inputCls} value={b.draft.seo_title} onChange={(e) => setBlog({ ...b, draft: { ...b.draft, seo_title: e.target.value } })} />
              </Field>
              <Field label="Meta description" right={<Counter value={b.draft.seo_description} min={limits.desc_min} max={limits.desc_max} />}>
                <textarea className={areaCls} rows={2} value={b.draft.seo_description} onChange={(e) => setBlog({ ...b, draft: { ...b.draft, seo_description: e.target.value } })} />
              </Field>
              <Field label="Focus keyword">
                <input className={inputCls} value={b.draft.focus_keyword} onChange={(e) => setBlog({ ...b, draft: { ...b.draft, focus_keyword: e.target.value } })} />
              </Field>
              {b.warnings?.length > 0 && (
                <div className="text-[9px] text-yellow-500/80 flex items-start gap-1">
                  <AlertTriangle size={9} className="mt-[2px] shrink-0" />
                  <span>{b.warnings.join(' · ')}</span>
                </div>
              )}
              {b.linkable > 0 && <div className="text-[9px] text-primary/35">Written with {b.linkable} of your existing pages available to link to.</div>}
            </>
          )}

          {b.created && (
            <div className="border border-primary/40 bg-primary/5 px-3 py-2.5 text-[11px] space-y-1.5">
              <div className="flex items-center gap-1.5 text-primary font-bold"><Check size={13} /> Draft created</div>
              <div className="text-primary/70">It's on your site as a draft. Publish it from WordPress when you're happy with it.</div>
              {b.created.edit_url && (
                <a href={b.created.edit_url} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-primary/70 hover:text-primary">
                  <ExternalLink size={11} /> Open it in WordPress
                </a>
              )}
            </div>
          )}
        </div>

        <div className="p-3 border-t border-primary/20 shrink-0 flex items-center gap-2">
          {!b.draft && !b.created && (
            <Btn kind="primary" onClick={generateBlog} disabled={genBlog}>
              {genBlog ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />} WRITE IT
            </Btn>
          )}
          {b.draft && (
            <>
              <Btn kind="primary" onClick={createBlog} disabled={posting || !b.draft.title.trim() || !b.draft.content.trim()}>
                {posting ? <Loader2 size={12} className="animate-spin" /> : <FileText size={12} />} SAVE AS DRAFT
              </Btn>
              <Btn onClick={generateBlog} disabled={genBlog}>
                {genBlog ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Rewrite
              </Btn>
            </>
          )}
          {b.created && (
            <Btn kind="primary" onClick={() => { setBlog({ form: { topic: '', keywords: '', tone: '', words: 700 } }); }}>
              <Plus size={12} /> ANOTHER
            </Btn>
          )}
        </div>
      </div>
    );
  }

  // ── the list ─────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto scrollbar-matrix p-3 space-y-2.5">
        {ownerLine && (
          <div className="text-[10px] text-primary/50 leading-relaxed border border-primary/15 px-3 py-2">
            {ownerLine}
            {ctx.sitemap_url && (
              <a href={ctx.sitemap_url} target="_blank" rel="noreferrer" className="ml-1 text-primary/70 hover:text-primary inline-flex items-center gap-1">
                sitemap <ExternalLink size={9} />
              </a>
            )}
            {ctx.blog_public === false && (
              <span className="block text-yellow-500/85 mt-1">
                Search engines are blocked site-wide (WordPress → Settings → Reading → "Discourage search engines"). Nothing here will be indexed until that is switched off.
              </span>
            )}
          </div>
        )}

        {err && <div className="text-red-400 text-[11px] border border-red-500/30 px-3 py-2">{err}</div>}
        {note && <div className="text-primary/80 text-[11px] border border-primary/40 bg-primary/5 px-3 py-2">{note}</div>}

        <div className="flex items-center gap-2">
          <div className="flex-1 flex items-center gap-1.5 bg-black/30 border border-primary/20 px-2 h-[34px]">
            <Search size={11} className="text-primary/35 shrink-0" />
            <input className="flex-1 bg-transparent text-[12px] text-primary focus:outline-none min-w-0"
              placeholder="Search content" value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') load(); }} />
          </div>
          <button onClick={() => load()} className="h-[34px] px-2.5 text-primary/60 hover:text-primary border border-primary/20 flex items-center gap-1 shrink-0">
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>

        <div className="flex items-center gap-2">
          <Btn onClick={runAudit} disabled={auditing}>
            {auditing ? <Loader2 size={11} className="animate-spin" /> : <AlertTriangle size={11} />} AUDIT
          </Btn>
          <Btn onClick={generateBatch} disabled={genBatch} kind={missing.length ? 'primary' : 'ghost'}>
            {genBatch ? <Loader2 size={11} className="animate-spin" /> : <Wand2 size={11} />} FILL MISSING ({missing.length})
          </Btn>
          <Btn onClick={() => { setView('blog'); setBlog({ form: { topic: '', keywords: '', tone: '', words: 700 } }); setNote(null); setErr(null); }}>
            <Plus size={11} /> POST
          </Btn>
        </div>

        {audit && (
          <div className="border border-primary/15 px-3 py-2 text-[10px] text-primary/55">
            <div className="flex items-center gap-3">
              <span className="text-red-400">{audit.counts?.high || 0} high</span>
              <span className="text-yellow-500/85">{audit.counts?.medium || 0} medium</span>
              <span>{audit.counts?.low || 0} low</span>
              <span className="ml-auto">{audit.scanned} scanned</span>
            </div>
            <div className="text-primary/35 mt-1">
              High = missing or duplicated metadata on something that is live. Tap an item to fix it.
            </div>
          </div>
        )}

        {batch && (
          <div className="border border-primary/40 bg-primary/5 p-3 space-y-2">
            <div className="text-[10px] text-primary/60 uppercase tracking-wider flex items-center gap-1.5">
              <Sparkles size={10} /> {batch.generated} to review{batch.missing?.length ? ` · ${batch.missing.length} not generated` : ''}
            </div>
            {batch.title_only > 0 && (
              <div className="text-[9px] text-yellow-500/80">
                {batch.title_only} of these had no page text to read, so they were written from the title alone.
              </div>
            )}
            <div className="space-y-1.5 max-h-[45vh] overflow-y-auto scrollbar-matrix">
              {(batch.suggestions || []).map((s) => (
                <SuggestionRow key={s.id} s={s} checked={!!batch.checked[s.id]}
                  onToggle={() => setBatch((cur) => ({ ...cur, checked: { ...cur.checked, [s.id]: !cur.checked[s.id] } }))} />
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Btn kind="primary" onClick={applyBatch} disabled={applying}>
                {applying ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                APPLY {(batch.suggestions || []).filter((s) => batch.checked[s.id]).length}
              </Btn>
              <Btn onClick={() => setBatch(null)}><X size={12} /> Cancel</Btn>
            </div>
          </div>
        )}

        {loading && items == null && (
          <div className="flex items-center gap-2 text-primary/60 text-xs py-3"><Loader2 size={13} className="animate-spin" /> Reading your site…</div>
        )}
        {!loading && items && items.length === 0 && <div className="text-[11px] text-primary/45 py-3">No pages, posts or products found.</div>}

        <div className="space-y-1.5">
          {(items || []).map((it) => {
            const issues = issuesById[it.id] || [];
            const worst = issues.some((i) => i.severity === 'high') ? 'high' : issues.some((i) => i.severity === 'medium') ? 'medium' : issues.length ? 'low' : null;
            const badge = worst === 'high' ? 'text-red-400 border-red-500/40' : worst === 'medium' ? 'text-yellow-500/80 border-yellow-500/40' : 'text-primary/50 border-primary/25';
            return (
              <button key={it.id} onClick={() => openItem(it)}
                className="w-full text-left border border-primary/15 hover:border-primary/40 transition-colors px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12px] text-primary/85 truncate">{it.title || '(untitled)'}</span>
                  <span className="flex items-center gap-1 shrink-0">
                    {worst && <span className={`text-[9px] uppercase px-1.5 py-0.5 border ${badge}`}>{issues.length}</span>}
                    {it.noindex && <span className="text-[9px] uppercase px-1.5 py-0.5 border border-yellow-500/40 text-yellow-500/80">noindex</span>}
                    <span className={`text-[9px] uppercase px-1.5 py-0.5 border ${it.status === 'publish' ? 'text-primary border-primary/50' : 'text-yellow-500/80 border-yellow-500/40'}`}>
                      {it.status === 'publish' ? 'live' : it.status}
                    </span>
                  </span>
                </div>
                <div className="text-[10px] text-primary/45 mt-0.5 truncate">{it.effective_title}</div>
                <div className="text-[9px] mt-0.5 flex items-center gap-2">
                  <span className={it.seo_title ? 'text-primary/40' : 'text-yellow-500/70'}>{it.seo_title ? 'title set' : 'no SEO title'}</span>
                  <span className={it.seo_description ? 'text-primary/40' : 'text-yellow-500/70'}>{it.seo_description ? 'description set' : 'no description'}</span>
                  {it.type && <span className="text-primary/25 uppercase">{it.type}</span>}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
