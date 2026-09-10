import { useState, useEffect, useCallback, useRef } from 'react';
import { Loader2, Check, ExternalLink, Package, ImagePlus, RefreshCw, Camera, Sparkles } from 'lucide-react';
import { base44 } from '@/api/base44Client';

// SHOP tab of the WEBSITE panel — run a connected WooCommerce store from
// here. New products are DRAFT unless you hit Publish. The plugin does the
// WooCommerce work; this signs and forwards.

const BLANK = {
  name: '', regular_price: '', sale_price: '', category: '', brand: '',
  stock: '', short_description: '', description: '',
};
const inputCls = 'w-full bg-black/30 border border-primary/20 px-2.5 h-[42px] text-[13px] text-primary focus:outline-none focus:border-primary/50';
const areaCls = 'w-full bg-black/30 border border-primary/20 px-2.5 py-2 text-[13px] text-primary focus:outline-none focus:border-primary/50';
const MAX_PHOTOS = 6;

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <div className="text-[10px] text-primary/45 uppercase tracking-wider mb-1">{label}</div>
      {children}
      {hint && <div className="text-[9px] text-primary/35 mt-0.5">{hint}</div>}
    </label>
  );
}

export default function ShopTab({ store, projectId }) {
  const [view, setView] = useState('add'); // add | list
  const [form, setForm] = useState(BLANK);
  const [photos, setPhotos] = useState([]); // [{ url, name }]
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [photoNote, setPhotoNote] = useState(null);
  const fileRef = useRef(null);
  const cameraRef = useRef(null);

  const [products, setProducts] = useState(null);
  const [loadingList, setLoadingList] = useState(false);

  const ctx = store?.context || {};
  const cats = ctx.categories || [];
  const brands = ctx.brands || [];
  const sym = ctx.currency_symbol || '$';

  const loadProducts = useCallback(async () => {
    setLoadingList(true); setErr(null);
    try {
      const { data } = await base44.functions.invoke('wordPressStoreAction', {
        projectId, action: 'list_products', data: { limit: 20 },
      });
      setProducts(data?.products || []);
    } catch (e) { setErr(e?.data?.error || e.message); }
    finally { setLoadingList(false); }
  }, [projectId]);

  useEffect(() => {
    if (view === 'list' && products == null) loadProducts();
  }, [view, products, loadProducts]);

  if (!store?.store_available) {
    return (
      <div className="p-4 text-[11px] text-primary/50 leading-relaxed">
        {store?.online
          ? 'WooCommerce isn’t active on this site — activate it to manage products here.'
          : 'Can’t reach the plugin right now. Check the site is up and the plugin is active, then reopen this panel.'}
      </div>
    );
  }

  const analyzeFromPhoto = async () => {
    if (!photos.length) { setErr('Add a photo first.'); return; }
    setAnalyzing(true); setErr(null); setPhotoNote(null);
    try {
      const { data } = await base44.functions.invoke('analyzeProductPhoto', {
        projectId,
        imageUrls: photos.map((p) => p.url),
        hint: [form.name, form.short_description, form.description].filter((s) => s && s.trim()).join(' — ') || undefined,
      });
      setForm((f) => ({
        ...f,
        name: data.name || f.name,
        category: data.category || f.category,
        brand: data.brand || f.brand,
        regular_price: data.suggested_price || f.regular_price,
        stock: data.stock || f.stock,
        short_description: data.short_description || f.short_description,
        description: data.description || f.description,
      }));
      if (data.notes_for_seller) setPhotoNote(data.notes_for_seller);
    } catch (e) {
      setErr('Photo analysis failed: ' + (e?.data?.error || e.message));
    } finally {
      setAnalyzing(false);
    }
  };

  const generateCopy = async () => {
    if (!form.name.trim()) { setErr('Add a product name before generating copy.'); return; }
    setGenerating(true); setErr(null);
    try {
      const { data } = await base44.functions.invoke('generateProductCopy', {
        projectId,
        name: form.name.trim(),
        category: form.category || undefined,
        brand: form.brand || undefined,
        // whatever's already typed in the description boxes becomes the
        // seller's rough notes for Morpheus to polish
        notes: [form.short_description, form.description].filter((s) => s && s.trim()).join('\n') || undefined,
        imageUrls: photos.map((p) => p.url),
      });
      setForm((f) => ({
        ...f,
        short_description: data.short_description || f.short_description,
        description: data.description || f.description,
      }));
    } catch (e) {
      setErr('Copy generation failed: ' + (e?.data?.error || e.message));
    } finally {
      setGenerating(false);
    }
  };

  const pickPhotos = async (fileList) => {
    const files = [...(fileList || [])].slice(0, MAX_PHOTOS - photos.length);
    if (!files.length) return;
    setUploading(true); setErr(null);
    try {
      for (const file of files) {
        const { file_url } = await base44.integrations.Core.UploadFile({ file });
        setPhotos((p) => (p.length >= MAX_PHOTOS ? p : [...p, { url: file_url, name: file.name }]));
      }
    } catch (e) { setErr('Photo upload failed: ' + (e?.data?.error || e.message)); }
    finally { setUploading(false); }
  };

  const submit = async (status) => {
    if (!form.name.trim()) { setErr('Give the product a name.'); return; }
    setSaving(true); setErr(null); setResult(null);
    const data = { name: form.name.trim(), status };
    if (form.regular_price !== '') data.regular_price = form.regular_price;
    if (form.sale_price !== '') data.sale_price = form.sale_price;
    if (form.stock !== '') data.stock = Number(form.stock);
    if (form.short_description.trim()) data.short_description = form.short_description.trim();
    if (form.description.trim()) data.description = form.description.trim();
    if (form.category) data.categories = [form.category];
    if (form.brand) data.brand = [form.brand];
    if (photos.length) data.images = photos.map((p) => p.url);
    try {
      const { data: res } = await base44.functions.invoke('wordPressStoreAction', {
        projectId, action: 'create_product', data,
      });
      if (res && res.ok === false) {
        setErr(res.message || res.error || 'The store rejected the product.');
      } else {
        setResult({ product: res.product, published: status === 'publish' });
        setForm(BLANK); setPhotos([]); setPhotoNote(null); setProducts(null);
      }
    } catch (e) { setErr(e?.data?.error || e.message); }
    finally { setSaving(false); }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex border-b border-primary/15 shrink-0 text-[11px]">
        <button onClick={() => setView('add')}
          className={`flex-1 h-[40px] flex items-center justify-center gap-1.5 ${view === 'add' ? 'text-primary border-b-2 border-primary' : 'text-primary/45'}`}>
          <Package size={13} /> ADD PRODUCT
        </button>
        <button onClick={() => setView('list')}
          className={`flex-1 h-[40px] flex items-center justify-center gap-1.5 ${view === 'list' ? 'text-primary border-b-2 border-primary' : 'text-primary/45'}`}>
          <RefreshCw size={13} /> RECENT
        </button>
      </div>

      {err && <div className="m-4 mb-0 text-red-400 text-[11px] border border-red-500/30 px-3 py-2">{err}</div>}

      {view === 'add' && (
        <>
          <div className="flex-1 overflow-y-auto scrollbar-matrix p-4 space-y-4">
            {result && (
              <div className="border border-primary/40 bg-primary/5 px-3 py-2.5 text-[11px] text-primary/80 leading-relaxed">
                <div className="flex items-center gap-1.5 text-primary font-bold mb-1">
                  <Check size={13} /> {result.published ? 'Published' : 'Saved as draft'}
                </div>
                “{result.product?.name}” — {result.published ? 'live now' : 'not visible to shoppers until you publish it'}.
                {result.product?.edit_url && (
                  <a href={result.product.edit_url} target="_blank" rel="noreferrer"
                    className="flex items-center gap-1 text-primary/70 hover:text-primary mt-1">
                    <ExternalLink size={11} /> Edit on your site
                  </a>
                )}
              </div>
            )}

            <Field label="Product name">
              <input className={inputCls} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label={`Price (${sym})`}>
                <input className={inputCls} inputMode="decimal" placeholder="0.00" value={form.regular_price}
                  onChange={(e) => setForm((f) => ({ ...f, regular_price: e.target.value }))} />
              </Field>
              <Field label={`Sale price (${sym})`} hint="optional">
                <input className={inputCls} inputMode="decimal" placeholder="—" value={form.sale_price}
                  onChange={(e) => setForm((f) => ({ ...f, sale_price: e.target.value }))} />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Category">
                <select className={inputCls} value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}>
                  <option value="">—</option>
                  {cats.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
                </select>
              </Field>
              {ctx.brand_taxonomy && (
                <Field label="Brand">
                  <select className={inputCls} value={form.brand} onChange={(e) => setForm((f) => ({ ...f, brand: e.target.value }))}>
                    <option value="">—</option>
                    {brands.map((b) => <option key={b.id} value={b.name}>{b.name}</option>)}
                  </select>
                </Field>
              )}
            </div>

            <Field label="Stock quantity" hint="leave blank for no stock tracking">
              <input className={inputCls} inputMode="numeric" placeholder="—" value={form.stock}
                onChange={(e) => setForm((f) => ({ ...f, stock: e.target.value }))} />
            </Field>

            <Field label={`Photos${photos.length ? ` (${photos.length}/${MAX_PHOTOS})` : ''}`} hint="first is the main image, the rest become the product gallery">
              <input ref={fileRef} type="file" accept="image/*" multiple className="hidden"
                onChange={(e) => pickPhotos(e.target.files)} />
              <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden"
                onChange={(e) => pickPhotos(e.target.files)} />

              {photos.length > 0 && (
                <div className="grid grid-cols-3 gap-2 mb-2">
                  {photos.map((p, i) => (
                    <div key={p.url} className="relative border border-primary/20 aspect-square">
                      <img src={p.url} alt="" className="w-full h-full object-cover" />
                      {i === 0 && <span className="absolute bottom-0 left-0 text-[8px] bg-primary text-black px-1">MAIN</span>}
                      <button onClick={() => setPhotos((ps) => ps.filter((x) => x.url !== p.url))}
                        className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-background border border-primary/40 text-primary/60 hover:text-red-400 text-[10px] leading-none">×</button>
                    </div>
                  ))}
                </div>
              )}

              {photos.length < MAX_PHOTOS && (
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={() => cameraRef.current?.click()} disabled={uploading}
                    className="flex items-center justify-center gap-1.5 h-[42px] border border-dashed border-primary/30 text-primary/55 hover:text-primary hover:border-primary/60 text-[12px] disabled:opacity-50">
                    {uploading ? <Loader2 size={13} className="animate-spin" /> : <Camera size={13} />} {photos.length ? 'Add' : 'Camera'}
                  </button>
                  <button onClick={() => fileRef.current?.click()} disabled={uploading}
                    className="flex items-center justify-center gap-1.5 h-[42px] border border-dashed border-primary/30 text-primary/55 hover:text-primary hover:border-primary/60 text-[12px] disabled:opacity-50">
                    {uploading ? <Loader2 size={13} className="animate-spin" /> : <ImagePlus size={13} />} Library
                  </button>
                </div>
              )}
            </Field>

            {photos.length > 0 && (
              <>
                <button onClick={analyzeFromPhoto} disabled={analyzing || uploading || generating}
                  className="w-full flex items-center justify-center gap-2 h-[44px] bg-primary text-black font-bold text-[12px] hover:bg-[#39ff14] disabled:opacity-40 transition-colors">
                  {analyzing ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                  {analyzing ? 'MORPHEUS IS LOOKING…' : `AUTO-FILL FROM ${photos.length === 1 ? 'PHOTO' : `${photos.length} PHOTOS`}`}
                </button>
                <div className="text-[9px] text-primary/35 -mt-2">
                  Reads all the photos together — name, category, brand, price, stock, copy. All editable after.
                </div>
                {photoNote && (
                  <div className="text-[10px] text-yellow-500/80 border border-yellow-500/25 px-2.5 py-1.5 leading-relaxed">
                    <span className="uppercase tracking-wide text-yellow-500/60">Check:</span> {photoNote}
                  </div>
                )}
              </>
            )}

            <button onClick={generateCopy} disabled={generating || uploading || !form.name.trim()}
              className="w-full flex items-center justify-center gap-2 h-[42px] border border-primary/50 text-primary/85 hover:border-primary hover:text-primary text-[12px] disabled:opacity-40">
              {generating ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
              {generating ? 'MORPHEUS IS WRITING…' : 'WRITE COPY WITH MORPHEUS'}
            </button>
            <div className="text-[9px] text-primary/35 -mt-2">
              Uses the name, category, brand and photo. Type rough notes in the boxes below first and Morpheus will polish them.
            </div>

            <Field label="Short description" hint="the blurb near the price">
              <textarea className={areaCls} rows={2} value={form.short_description}
                onChange={(e) => setForm((f) => ({ ...f, short_description: e.target.value }))} />
            </Field>

            <Field label="Full description">
              <textarea className={areaCls} rows={5} value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
            </Field>
          </div>

          <div className="p-3 border-t border-primary/20 shrink-0 flex items-center gap-2">
            <button onClick={() => submit('draft')} disabled={saving || uploading || generating || analyzing || !form.name.trim()}
              className="flex-1 flex items-center justify-center gap-1.5 h-[44px] border border-primary/50 text-primary/85 hover:border-primary hover:text-primary text-[12px] disabled:opacity-40">
              {saving ? <Loader2 size={13} className="animate-spin" /> : null} SAVE DRAFT
            </button>
            <button onClick={() => submit('publish')} disabled={saving || uploading || generating || analyzing || !form.name.trim()}
              className="flex-1 flex items-center justify-center gap-1.5 h-[44px] bg-primary text-black font-bold text-[12px] hover:bg-[#39ff14] disabled:opacity-40 transition-colors">
              {saving ? <Loader2 size={13} className="animate-spin" /> : null} PUBLISH
            </button>
          </div>
        </>
      )}

      {view === 'list' && (
        <div className="flex-1 overflow-y-auto scrollbar-matrix p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] text-primary/40">{products?.length || 0} recent</span>
            <button onClick={loadProducts} className="text-[10px] text-primary/50 hover:text-primary flex items-center gap-1">
              <RefreshCw size={10} /> refresh
            </button>
          </div>
          {loadingList && <div className="flex items-center gap-2 text-primary/60 text-xs py-3"><Loader2 size={13} className="animate-spin" /> Loading…</div>}
          {!loadingList && products && products.length === 0 && <div className="text-[11px] text-primary/45 py-3">No products yet.</div>}
          <div className="space-y-1.5">
            {(products || []).map((p) => (
              <a key={p.id} href={p.edit_url} target="_blank" rel="noreferrer"
                className="block border border-primary/15 hover:border-primary/40 px-3 py-2 transition-colors">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12px] text-primary/85 truncate">{p.name}</span>
                  <span className={`text-[9px] uppercase px-1.5 py-0.5 border shrink-0 ${p.status === 'publish' ? 'text-primary border-primary/50' : 'text-yellow-500/80 border-yellow-500/40'}`}>
                    {p.status === 'publish' ? 'live' : p.status}
                  </span>
                </div>
                <div className="text-[10px] text-primary/40 mt-0.5">
                  {p.sku ? `${p.sku} · ` : ''}{p.price ? `${sym}${p.price}` : 'no price'}{p.stock != null ? ` · ${p.stock} in stock` : ''}
                </div>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
