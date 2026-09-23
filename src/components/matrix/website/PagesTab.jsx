import { useState, useEffect, useCallback } from 'react';
import { Loader2, Check, ExternalLink, RefreshCw, ChevronLeft, Trash2, Plus, Eye, EyeOff } from 'lucide-react';
import { base44 } from '@/api/base44Client';

// PAGES tab of the WEBSITE panel — plain WordPress page content, no
// WooCommerce needed. List → edit → SAVE / Publish|Unpublish / Trash. New
// pages are DRAFT unless you publish them, same rule as products and posts.

const inputCls = 'w-full bg-black/30 border border-primary/20 px-2.5 h-[42px] text-[13px] text-primary focus:outline-none focus:border-primary/50';
const areaCls = 'w-full bg-black/30 border border-primary/20 px-2.5 py-2 text-[13px] text-primary focus:outline-none focus:border-primary/50';
const BLANK = { title: '', content: '', excerpt: '', seo_title: '', seo_description: '' };

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <div className="text-[10px] text-primary/45 uppercase tracking-wider mb-1">{label}</div>
      {children}
      {hint && <div className="text-[9px] text-ink/35 mt-0.5">{hint}</div>}
    </label>
  );
}

export default function PagesTab({ projectId, store }) {
  // SEO fields work whether or not Yoast is installed — the plugin's own SEO
  // module stores them either way (and writes into Yoast's keys when it is
  // active). Falls back to the store context for pre-0.5 plugin builds.
  const seoAvailable = !!(store?.seo_available ?? store?.context?.seo_available);
  const [view, setView] = useState('list'); // list | edit
  const [pages, setPages] = useState(null);
  const [loadingList, setLoadingList] = useState(false);
  const [search, setSearch] = useState('');
  const [err, setErr] = useState(null);

  const [editId, setEditId] = useState(null); // null = new page
  const [editStatus, setEditStatus] = useState(null);
  const [form, setForm] = useState(BLANK);
  const [loadingEdit, setLoadingEdit] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [result, setResult] = useState(null);

  const loadPages = useCallback(async () => {
    setLoadingList(true); setErr(null);
    try {
      const { data } = await base44.functions.invoke('wordPressStoreAction', {
        projectId, action: 'list_pages', data: { limit: 30, search: search.trim() || undefined },
      });
      setPages(data?.pages || []);
    } catch (e) { setErr(e?.data?.error || e.message); }
    finally { setLoadingList(false); }
  }, [projectId, search]);

  useEffect(() => {
    if (view === 'list' && pages == null) loadPages();
  }, [view, pages, loadPages]);

  const openNew = () => {
    setView('edit'); setEditId(null); setEditStatus(null);
    setForm(BLANK); setErr(null); setResult(null); setConfirmDelete(false);
  };

  const openEdit = async (id) => {
    setView('edit'); setEditId(id); setConfirmDelete(false);
    setLoadingEdit(true); setErr(null); setResult(null);
    try {
      const { data } = await base44.functions.invoke('wordPressStoreAction', {
        projectId, action: 'get_page', data: { id },
      });
      const p = data?.page;
      if (!p) { setErr('Could not load that page.'); return; }
      setEditStatus(p.status);
      setForm({
        title: p.title || '', content: p.content || '', excerpt: p.excerpt || '',
        seo_title: p.seo_title || '', seo_description: p.seo_description || '',
      });
    } catch (e) { setErr(e?.data?.error || e.message); }
    finally { setLoadingEdit(false); }
  };

  const backToList = () => {
    setView('list'); setEditId(null); setForm(BLANK); setResult(null); setErr(null);
  };

  const save = async (status) => {
    if (!form.title.trim()) { setErr('Give the page a title.'); return; }
    setSaving(true); setErr(null);
    try {
      const data = { title: form.title.trim(), content: form.content, excerpt: form.excerpt.trim() };
      if (seoAvailable) {
        data.seo_title = form.seo_title.trim();
        data.seo_description = form.seo_description.trim();
      }
      if (status) data.status = status;
      if (editId == null) {
        const { data: res } = await base44.functions.invoke('wordPressStoreAction', {
          projectId, action: 'create_page', data: { ...data, status: status || 'draft' },
        });
        if (res && res.ok === false) { setErr(res.message || res.error || 'The site rejected the page.'); return; }
        setResult({ page: res.page, published: (res.page?.status) === 'publish' });
        setEditId(res.page?.id ?? null);
        setEditStatus(res.page?.status || 'draft');
        setPages(null);
      } else {
        const { data: res } = await base44.functions.invoke('wordPressStoreAction', {
          projectId, action: 'update_page', data: { id: editId, ...data },
        });
        if (res && res.ok === false) { setErr(res.message || res.error || 'The site rejected the change.'); return; }
        setResult({ page: res.page, edited: true });
        setEditStatus(res.page?.status || editStatus);
        setPages(null);
      }
    } catch (e) { setErr(e?.data?.error || e.message); }
    finally { setSaving(false); }
  };

  const doDelete = async () => {
    if (editId == null) return;
    setSaving(true); setErr(null);
    try {
      const { data: res } = await base44.functions.invoke('wordPressStoreAction', {
        projectId, action: 'delete_page', data: { id: editId },
      });
      if (res && res.ok === false) { setErr(res.message || res.error || 'Could not remove the page.'); return; }
      setPages(null); backToList();
    } catch (e) { setErr(e?.data?.error || e.message); }
    finally { setSaving(false); }
  };

  const busy = saving || loadingEdit;

  return (
    <div className="flex flex-col h-full">
      {view === 'list' && (
        <div className="flex-1 overflow-y-auto scrollbar-matrix p-3">
          <div className="flex items-center gap-2 mb-2">
            <input className="flex-1 bg-black/30 border border-primary/20 px-2.5 h-[34px] text-[12px] text-primary focus:outline-none focus:border-primary/50"
              placeholder="Search pages" value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { setPages(null); loadPages(); } }} />
            <button onClick={() => { setPages(null); loadPages(); }}
              className="h-[34px] px-2.5 text-[11px] text-primary/60 hover:text-primary border border-primary/20 flex items-center gap-1">
              <RefreshCw size={11} />
            </button>
            <button onClick={openNew}
              className="h-[34px] px-2.5 text-[11px] bg-primary text-black font-bold hover:bg-[#39ff14] flex items-center gap-1">
              <Plus size={12} /> NEW
            </button>
          </div>

          {err && <div className="mb-2 text-red-400 text-[11px] border border-red-500/30 px-3 py-2">{err}</div>}
          {loadingList && <div className="flex items-center gap-2 text-primary/60 text-xs py-3"><Loader2 size={13} className="animate-spin" /> Loading…</div>}
          {!loadingList && pages && pages.length === 0 && <div className="text-[11px] text-ink/45 py-3">No pages found.</div>}

          <div className="space-y-1.5">
            {(pages || []).map((p) => (
              <div key={p.id} className="border border-primary/15 hover:border-primary/40 transition-colors">
                <button onClick={() => openEdit(p.id)} className="w-full text-left px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12px] text-ink/85 truncate">{p.title || '(untitled)'}</span>
                    <span className={`text-[9px] uppercase px-1.5 py-0.5 border shrink-0 ${p.status === 'publish' ? 'text-primary border-primary/50' : 'text-yellow-500/80 border-yellow-500/40'}`}>
                      {p.status === 'publish' ? 'live' : p.status}
                    </span>
                  </div>
                  <div className="text-[10px] text-ink/40 mt-0.5 truncate">/{p.slug}</div>
                </button>
                {p.edit_url && (
                  <a href={p.edit_url} target="_blank" rel="noreferrer"
                    className="block px-3 pb-1.5 -mt-1 text-[9px] text-primary/35 hover:text-primary/70 flex items-center gap-1">
                    <ExternalLink size={9} /> open in WordPress
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {view === 'edit' && (
        <>
          <div className="flex items-center gap-2 border-b border-primary/15 shrink-0 h-[40px] px-3">
            <button onClick={backToList} className="flex items-center gap-1 text-[11px] text-primary/60 hover:text-primary">
              <ChevronLeft size={14} /> Pages
            </button>
            <span className="text-[11px] text-ink/80 truncate ml-1">{editId == null ? 'New page' : (form.title || 'Edit page')}</span>
            {editStatus && (
              <span className={`ml-auto text-[9px] uppercase px-1.5 py-0.5 border shrink-0 ${editStatus === 'publish' ? 'text-primary border-primary/50' : 'text-yellow-500/80 border-yellow-500/40'}`}>
                {editStatus === 'publish' ? 'live' : editStatus}
              </span>
            )}
          </div>

          {err && <div className="m-4 mb-0 text-red-400 text-[11px] border border-red-500/30 px-3 py-2">{err}</div>}

          {loadingEdit ? (
            <div className="flex items-center gap-2 text-primary/60 text-xs p-4"><Loader2 size={13} className="animate-spin" /> Loading…</div>
          ) : (
            <div className="flex-1 overflow-y-auto scrollbar-matrix p-4 space-y-4">
              {result && (
                <div className="border border-primary/40 bg-primary/5 px-3 py-2.5 text-[11px] text-primary/80 leading-relaxed">
                  <div className="flex items-center gap-1.5 text-primary font-bold mb-1"><Check size={13} /> Saved{result.published === false ? ' as draft' : ''}.</div>
                  {result.page?.edit_url && (
                    <a href={result.page.edit_url} target="_blank" rel="noreferrer"
                      className="flex items-center gap-1 text-primary/70 hover:text-primary mt-1">
                      <ExternalLink size={11} /> Edit on your site
                    </a>
                  )}
                </div>
              )}
              <Field label="Title">
                <input className={inputCls} value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
              </Field>
              <Field label="Content" hint="basic HTML is fine — headings, paragraphs, links">
                <textarea className={areaCls} rows={10} value={form.content} onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))} />
              </Field>
              <Field label="Excerpt" hint="optional — used by some themes for previews">
                <textarea className={areaCls} rows={2} value={form.excerpt} onChange={(e) => setForm((f) => ({ ...f, excerpt: e.target.value }))} />
              </Field>
              {seoAvailable && (
                <>
                  <Field label="SEO title" hint="shown in Google and the browser tab">
                    <input className={inputCls} value={form.seo_title} onChange={(e) => setForm((f) => ({ ...f, seo_title: e.target.value }))} />
                  </Field>
                  <Field label="SEO description" hint="the blurb under the title in search results">
                    <textarea className={areaCls} rows={2} value={form.seo_description} onChange={(e) => setForm((f) => ({ ...f, seo_description: e.target.value }))} />
                  </Field>
                </>
              )}
            </div>
          )}

          {!loadingEdit && (
            <div className="p-3 border-t border-primary/20 shrink-0 space-y-2">
              {confirmDelete ? (
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-ink/70 flex-1">Move to trash? You can restore it on your site.</span>
                  <button onClick={() => setConfirmDelete(false)} className="h-[36px] px-3 text-[11px] border border-primary/30 text-primary/70">Cancel</button>
                  <button onClick={doDelete} disabled={saving}
                    className="h-[36px] px-3 text-[11px] bg-red-500/80 text-white hover:bg-red-500 disabled:opacity-40 flex items-center gap-1">
                    {saving ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />} Trash
                  </button>
                </div>
              ) : editId == null ? (
                <div className="flex items-center gap-2">
                  <button onClick={() => save('draft')} disabled={busy || !form.title.trim()}
                    className="flex-1 h-[44px] border border-primary/50 text-primary/85 hover:border-primary hover:text-primary text-[12px] disabled:opacity-40 flex items-center justify-center gap-1.5">
                    {saving ? <Loader2 size={13} className="animate-spin" /> : null} SAVE DRAFT
                  </button>
                  <button onClick={() => save('publish')} disabled={busy || !form.title.trim()}
                    className="flex-1 h-[44px] bg-primary text-black font-bold text-[12px] hover:bg-[#39ff14] disabled:opacity-40 transition-colors flex items-center justify-center gap-1.5">
                    {saving ? <Loader2 size={13} className="animate-spin" /> : null} PUBLISH
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <button onClick={() => save()} disabled={busy || !form.title.trim()}
                    className="flex-1 h-[44px] bg-primary text-black font-bold text-[12px] hover:bg-[#39ff14] disabled:opacity-40 transition-colors flex items-center justify-center gap-1.5">
                    {saving ? <Loader2 size={13} className="animate-spin" /> : null} SAVE CHANGES
                  </button>
                  {editStatus === 'publish' ? (
                    <button onClick={() => save('draft')} disabled={busy}
                      className="h-[44px] px-3 border border-primary/50 text-primary/85 hover:border-primary hover:text-primary text-[12px] disabled:opacity-40 flex items-center gap-1.5">
                      <EyeOff size={13} /> Unpublish
                    </button>
                  ) : (
                    <button onClick={() => save('publish')} disabled={busy}
                      className="h-[44px] px-3 border border-primary/50 text-primary/85 hover:border-primary hover:text-primary text-[12px] disabled:opacity-40 flex items-center gap-1.5">
                      <Eye size={13} /> Publish
                    </button>
                  )}
                  <button onClick={() => setConfirmDelete(true)} disabled={busy}
                    className="h-[44px] px-3 border border-red-500/30 text-red-400/80 hover:border-red-500/60 hover:text-red-400 disabled:opacity-40">
                    <Trash2 size={14} />
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
