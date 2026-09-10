import { useState, useEffect, useCallback, useRef } from 'react';
import { X, Store, Loader2, Check, Plug, ExternalLink, Package, ImagePlus, RefreshCw } from 'lucide-react';
import { base44 } from '@/api/base44Client';

// STORE panel (2026-09-10) — run a connected WordPress/WooCommerce shop from
// your phone. The project connects to a Morpheus plugin on the operator's own
// site ({ site URL, shared signing secret }); every action is HMAC-signed and
// executed by the plugin against WooCommerce's own PHP API. Morpheus stores
// only the connection — never the catalogue. New products are created as
// DRAFT unless you explicitly hit Publish.
//
// Backend: connectWordPress / getWordPressStore / wordPressStoreAction /
// disconnectWordPress → server/src/lib/wpPlugin.js.

const BLANK = {
  name: '',
  regular_price: '',
  sale_price: '',
  category: '',
  brand: '',
  stock: '',
  short_description: '',
  description: '',
};

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <div className="text-[10px] text-primary/45 uppercase tracking-wider mb-1">{label}</div>
      {children}
      {hint && <div className="text-[9px] text-primary/35 mt-0.5">{hint}</div>}
    </label>
  );
}

const inputCls =
  'w-full bg-black/30 border border-primary/20 px-2.5 h-[42px] text-[13px] text-primary focus:outline-none focus:border-primary/50';
const areaCls =
  'w-full bg-black/30 border border-primary/20 px-2.5 py-2 text-[13px] text-primary focus:outline-none focus:border-primary/50';

export default function StorePanel({ open, onClose, projectId, onConnectedChange }) {
  const [state, setState] = useState(null); // getWordPressStore result
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  // connect form
  const [siteUrl, setSiteUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [connecting, setConnecting] = useState(false);

  // product form
  const [view, setView] = useState('add'); // 'add' | 'list'
  const [form, setForm] = useState(BLANK);
  const [photo, setPhoto] = useState(null); // { url, name }
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null); // { product, published }
  const fileRef = useRef(null);

  // recent products
  const [products, setProducts] = useState(null);
  const [loadingList, setLoadingList] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setErr(null);
    try {
      const { data } = await base44.functions.invoke('getWordPressStore', { projectId });
      setState(data);
      onConnectedChange?.(!!data?.connected);
    } catch (e) {
      setErr(e?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, [projectId, onConnectedChange]);

  useEffect(() => {
    if (open) {
      setErr(null);
      setResult(null);
      setView('add');
      load();
    }
  }, [open, load]);

  const loadProducts = useCallback(async () => {
    setLoadingList(true);
    try {
      const { data } = await base44.functions.invoke('wordPressStoreAction', {
        projectId,
        action: 'list_products',
        data: { limit: 20 },
      });
      setProducts(data?.products || []);
    } catch (e) {
      setErr(e?.data?.error || e.message);
    } finally {
      setLoadingList(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (open && view === 'list' && products == null && state?.store_available) loadProducts();
  }, [open, view, products, state, loadProducts]);

  if (!open) return null;

  const connect = async () => {
    setConnecting(true);
    setErr(null);
    try {
      await base44.functions.invoke('connectWordPress', {
        projectId,
        siteUrl: siteUrl.trim(),
        webhookSecret: secret.trim(),
      });
      setSecret('');
      await load();
    } catch (e) {
      setErr(e?.data?.error || e.message);
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    setErr(null);
    try {
      await base44.functions.invoke('disconnectWordPress', { projectId });
      setState({ connected: false });
      setProducts(null);
      onConnectedChange?.(false);
    } catch (e) {
      setErr(e?.data?.error || e.message);
    }
  };

  const pickPhoto = async (file) => {
    if (!file) return;
    setUploading(true);
    setErr(null);
    try {
      const { file_url } = await base44.integrations.Core.UploadFile({ file });
      setPhoto({ url: file_url, name: file.name });
    } catch (e) {
      setErr('Photo upload failed: ' + (e?.data?.error || e.message));
    } finally {
      setUploading(false);
    }
  };

  const submit = async (status) => {
    if (!form.name.trim()) {
      setErr('Give the product a name.');
      return;
    }
    setSaving(true);
    setErr(null);
    setResult(null);
    const data = {
      name: form.name.trim(),
      status, // 'draft' | 'publish'
    };
    if (form.regular_price !== '') data.regular_price = form.regular_price;
    if (form.sale_price !== '') data.sale_price = form.sale_price;
    if (form.stock !== '') data.stock = Number(form.stock);
    if (form.short_description.trim()) data.short_description = form.short_description.trim();
    if (form.description.trim()) data.description = form.description.trim();
    if (form.category) data.categories = [form.category];
    if (form.brand) data.brand = [form.brand];
    if (photo?.url) data.images = [photo.url];

    try {
      const { data: res } = await base44.functions.invoke('wordPressStoreAction', {
        projectId,
        action: 'create_product',
        data,
      });
      if (res && res.ok === false) {
        setErr(res.message || res.error || 'The store rejected the product.');
      } else {
        setResult({ product: res.product, published: status === 'publish' });
        setForm(BLANK);
        setPhoto(null);
        setProducts(null); // force a refresh next time the list opens
      }
    } catch (e) {
      setErr(e?.data?.error || e.message);
    } finally {
      setSaving(false);
    }
  };

  const ctx = state?.context || {};
  const cats = ctx.categories || [];
  const brands = ctx.brands || [];
  const sym = ctx.currency_symbol || '$';
  const connected = state?.connected;
  const storeReady = connected && state?.store_available;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/80" onClick={onClose}>
      <div
        className="bg-background border-l border-primary/40 w-full max-w-md h-full flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-primary/20 shrink-0">
          <div className="flex items-center gap-2">
            <Store size={16} className="text-primary" />
            <span className="text-primary font-display tracking-wider text-sm">STORE</span>
          </div>
          <button onClick={onClose} className="text-primary/60 hover:text-primary p-1"><X size={18} /></button>
        </div>

        {/* intro / status */}
        <div className="px-4 py-2 border-b border-primary/10 shrink-0">
          {connected ? (
            <div className="flex items-center justify-between gap-2 text-[11px]">
              <span className="text-primary/60 truncate">
                <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1.5 ${state.online ? 'bg-primary' : 'bg-red-500'}`} />
                {state.siteUrl?.replace(/^https?:\/\//, '')}
                {state.online && state.woocommerce ? ` · WooCommerce ${state.woocommerce}` : state.online ? ' · plugin online' : ' · unreachable'}
              </span>
              <button onClick={disconnect} className="text-primary/40 hover:text-red-400 shrink-0">Disconnect</button>
            </div>
          ) : (
            <p className="text-[11px] text-primary/45 leading-relaxed">
              Connect the Morpheus plugin on your WordPress site to add products and posts from here. Morpheus keeps only the connection — the shop stays entirely on your site.
            </p>
          )}
        </div>

        {err && (
          <div className="m-4 mb-0 text-red-400 text-[11px] border border-red-500/30 px-3 py-2">{err}</div>
        )}

        {/* ---- not connected: connect form ---- */}
        {!loading && !connected && (
          <div className="flex-1 overflow-y-auto scrollbar-matrix p-4 space-y-4">
            <Field label="WordPress site URL" hint="The site the Morpheus plugin is installed and activated on.">
              <input
                className={inputCls}
                placeholder="https://valiantmusic.com.au"
                value={siteUrl}
                onChange={(e) => setSiteUrl(e.target.value)}
                autoCapitalize="off"
                autoCorrect="off"
              />
            </Field>
            <Field label="Signing secret" hint="Settings → Morpheus on your site. At least 12 characters. Stored encrypted here, never shown again.">
              <input
                className={inputCls}
                type="password"
                placeholder="the shared secret"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                autoCapitalize="off"
                autoCorrect="off"
              />
            </Field>
            <button
              onClick={connect}
              disabled={connecting || !siteUrl.trim() || secret.trim().length < 12}
              className="w-full flex items-center justify-center gap-2 h-[44px] bg-primary text-black font-bold text-[13px] hover:bg-[#39ff14] disabled:opacity-40 transition-colors"
            >
              {connecting ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />}
              {connecting ? 'CONNECTING…' : 'CONNECT'}
            </button>
          </div>
        )}

        {loading && (
          <div className="p-4 flex items-center gap-2 text-primary/60 text-xs">
            <Loader2 size={14} className="animate-spin" /> Loading…
          </div>
        )}

        {/* ---- connected but WooCommerce missing ---- */}
        {!loading && connected && !storeReady && (
          <div className="p-4 text-[11px] text-primary/50 leading-relaxed">
            {state.online
              ? 'The plugin is online but WooCommerce isn’t active on this site — activate WooCommerce to manage products. You can still connect and use it once it’s live.'
              : 'Can’t reach the plugin right now. Check the site is up and the plugin is still activated, then reopen this panel.'}
          </div>
        )}

        {/* ---- connected + store ready ---- */}
        {!loading && storeReady && (
          <>
            {/* tab switch */}
            <div className="flex border-b border-primary/15 shrink-0 text-[11px]">
              <button
                onClick={() => setView('add')}
                className={`flex-1 h-[40px] flex items-center justify-center gap-1.5 ${view === 'add' ? 'text-primary border-b-2 border-primary' : 'text-primary/45'}`}
              >
                <Package size={13} /> ADD PRODUCT
              </button>
              <button
                onClick={() => setView('list')}
                className={`flex-1 h-[40px] flex items-center justify-center gap-1.5 ${view === 'list' ? 'text-primary border-b-2 border-primary' : 'text-primary/45'}`}
              >
                <RefreshCw size={13} /> RECENT
              </button>
            </div>

            {view === 'add' && (
              <div className="flex-1 overflow-y-auto scrollbar-matrix p-4 space-y-4">
                {result && (
                  <div className="border border-primary/40 bg-primary/5 px-3 py-2.5 text-[11px] text-primary/80 leading-relaxed">
                    <div className="flex items-center gap-1.5 text-primary font-bold mb-1">
                      <Check size={13} /> {result.published ? 'Published' : 'Saved as draft'}
                    </div>
                    “{result.product?.name}” — {result.published ? 'live now' : 'not visible to shoppers until you publish it'}.
                    {result.product?.edit_url && (
                      <a
                        href={result.product.edit_url}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-1 text-primary/70 hover:text-primary mt-1"
                      >
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
                    <input
                      className={inputCls}
                      inputMode="decimal"
                      placeholder="0.00"
                      value={form.regular_price}
                      onChange={(e) => setForm((f) => ({ ...f, regular_price: e.target.value }))}
                    />
                  </Field>
                  <Field label={`Sale price (${sym})`} hint="optional">
                    <input
                      className={inputCls}
                      inputMode="decimal"
                      placeholder="—"
                      value={form.sale_price}
                      onChange={(e) => setForm((f) => ({ ...f, sale_price: e.target.value }))}
                    />
                  </Field>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <Field label="Category">
                    <select
                      className={inputCls}
                      value={form.category}
                      onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                    >
                      <option value="">—</option>
                      {cats.map((c) => (
                        <option key={c.id} value={c.name}>{c.name}</option>
                      ))}
                    </select>
                  </Field>
                  {ctx.brand_taxonomy && (
                    <Field label="Brand">
                      <select
                        className={inputCls}
                        value={form.brand}
                        onChange={(e) => setForm((f) => ({ ...f, brand: e.target.value }))}
                      >
                        <option value="">—</option>
                        {brands.map((b) => (
                          <option key={b.id} value={b.name}>{b.name}</option>
                        ))}
                      </select>
                    </Field>
                  )}
                </div>

                <Field label="Stock quantity" hint="leave blank for no stock tracking">
                  <input
                    className={inputCls}
                    inputMode="numeric"
                    placeholder="—"
                    value={form.stock}
                    onChange={(e) => setForm((f) => ({ ...f, stock: e.target.value }))}
                  />
                </Field>

                <Field label="Short description" hint="the blurb near the price">
                  <textarea
                    className={areaCls}
                    rows={2}
                    value={form.short_description}
                    onChange={(e) => setForm((f) => ({ ...f, short_description: e.target.value }))}
                  />
                </Field>

                <Field label="Full description">
                  <textarea
                    className={areaCls}
                    rows={4}
                    value={form.description}
                    onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  />
                </Field>

                <Field label="Photo" hint="added to your site’s media library as the product image">
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => pickPhoto(e.target.files?.[0])}
                  />
                  {photo ? (
                    <div className="flex items-center gap-2 border border-primary/20 px-2.5 py-2">
                      <img src={photo.url} alt="" className="w-10 h-10 object-cover border border-primary/20" />
                      <span className="text-[11px] text-primary/70 truncate flex-1">{photo.name}</span>
                      <button onClick={() => setPhoto(null)} className="text-primary/40 hover:text-red-400 text-[11px]">remove</button>
                    </div>
                  ) : (
                    <button
                      onClick={() => fileRef.current?.click()}
                      disabled={uploading}
                      className="w-full flex items-center justify-center gap-2 h-[42px] border border-dashed border-primary/30 text-primary/55 hover:text-primary hover:border-primary/60 text-[12px] disabled:opacity-50"
                    >
                      {uploading ? <Loader2 size={13} className="animate-spin" /> : <ImagePlus size={13} />}
                      {uploading ? 'Uploading…' : 'Choose a photo'}
                    </button>
                  )}
                </Field>
              </div>
            )}

            {view === 'add' && (
              <div className="p-3 border-t border-primary/20 shrink-0 flex items-center gap-2">
                <button
                  onClick={() => submit('draft')}
                  disabled={saving || uploading || !form.name.trim()}
                  className="flex-1 flex items-center justify-center gap-1.5 h-[44px] border border-primary/50 text-primary/85 hover:border-primary hover:text-primary text-[12px] disabled:opacity-40"
                >
                  {saving ? <Loader2 size={13} className="animate-spin" /> : null}
                  SAVE DRAFT
                </button>
                <button
                  onClick={() => submit('publish')}
                  disabled={saving || uploading || !form.name.trim()}
                  className="flex-1 flex items-center justify-center gap-1.5 h-[44px] bg-primary text-black font-bold text-[12px] hover:bg-[#39ff14] disabled:opacity-40 transition-colors"
                >
                  {saving ? <Loader2 size={13} className="animate-spin" /> : null}
                  PUBLISH
                </button>
              </div>
            )}

            {view === 'list' && (
              <div className="flex-1 overflow-y-auto scrollbar-matrix p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] text-primary/40">{products?.length || 0} recent</span>
                  <button onClick={loadProducts} className="text-[10px] text-primary/50 hover:text-primary flex items-center gap-1">
                    <RefreshCw size={10} /> refresh
                  </button>
                </div>
                {loadingList && (
                  <div className="flex items-center gap-2 text-primary/60 text-xs py-3">
                    <Loader2 size={13} className="animate-spin" /> Loading…
                  </div>
                )}
                {!loadingList && products && products.length === 0 && (
                  <div className="text-[11px] text-primary/45 py-3">No products yet.</div>
                )}
                <div className="space-y-1.5">
                  {(products || []).map((p) => (
                    <a
                      key={p.id}
                      href={p.edit_url}
                      target="_blank"
                      rel="noreferrer"
                      className="block border border-primary/15 hover:border-primary/40 px-3 py-2 transition-colors"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[12px] text-primary/85 truncate">{p.name}</span>
                        <span
                          className={`text-[9px] uppercase px-1.5 py-0.5 border shrink-0 ${
                            p.status === 'publish'
                              ? 'text-primary border-primary/50'
                              : 'text-yellow-500/80 border-yellow-500/40'
                          }`}
                        >
                          {p.status === 'publish' ? 'live' : p.status}
                        </span>
                      </div>
                      <div className="text-[10px] text-primary/40 mt-0.5">
                        {p.sku ? `${p.sku} · ` : ''}
                        {p.price ? `${sym}${p.price}` : 'no price'}
                        {p.stock != null ? ` · ${p.stock} in stock` : ''}
                      </div>
                    </a>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
