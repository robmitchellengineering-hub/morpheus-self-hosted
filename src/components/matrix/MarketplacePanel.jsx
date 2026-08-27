import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { X, Search, Store, Upload, Download, Tag, Loader2, DollarSign, CheckCircle2, Image as ImageIcon, Link2, Copy } from 'lucide-react';
import SheetSelect from './SheetSelect';

export default function MarketplacePanel({ open, onClose, currentProject, onInstalled }) {
  const [tab, setTab] = useState('browse');
  const [templates, setTemplates] = useState([]);
  const [categories, setCategories] = useState([]);
  const [category, setCategory] = useState('all');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState(null);
  const [buying, setBuying] = useState(null);
  const [error, setError] = useState('');
  const [publishTags, setPublishTags] = useState('');
  const [publishCategory, setPublishCategory] = useState('general');
  const [publishPrice, setPublishPrice] = useState('0');
  const [publishIcon, setPublishIcon] = useState('');
  const [publishScreenshots, setPublishScreenshots] = useState([]);
  const [publishLongDesc, setPublishLongDesc] = useState('');
  const [uploadingIcon, setUploadingIcon] = useState(false);
  const [uploadingShot, setUploadingShot] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishMsg, setPublishMsg] = useState('');
  const [shareUrl, setShareUrl] = useState('');
  const [user, setUser] = useState(null);
  const [purchaseMsg, setPurchaseMsg] = useState('');
  const [copiedId, setCopiedId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await base44.functions.invoke('browseTemplates', { category, q: query });
      setTemplates(res.data?.templates || []);
      setCategories(res.data?.categories || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [category, query]);

  useEffect(() => {
    if (open) {
      load();
      base44.auth.me().then(setUser).catch(() => {});
      const params = new URLSearchParams(window.location.search);
      if (params.get('purchase') === 'success') {
        setPurchaseMsg('Payment successful. Your purchased construct is now installable.');
        window.history.replaceState({}, '', window.location.pathname);
      } else if (params.get('purchase') === 'cancelled') {
        setPurchaseMsg('Payment cancelled.');
        window.history.replaceState({}, '', window.location.pathname);
      }
    }
  }, [open, load]);

  const install = async (template) => {
    setInstalling(template.id);
    setError('');
    try {
      const res = await base44.functions.invoke('installTemplate', { templateId: template.id });
      if (onInstalled) onInstalled(res.data);
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setInstalling(null);
    }
  };

  const buy = async (template) => {
    if (window.self !== window.top) {
      setError('Checkout works only from the published app. Open the app in a new tab to purchase.');
      return;
    }
    if (!user) {
      setError('You must be signed in to purchase.');
      return;
    }
    setBuying(template.id);
    setError('');
    try {
      const origin = window.location.origin;
      const successUrl = `${origin}/workspace?purchase=success&template_id=${template.id}`;
      const cancelUrl = `${origin}/workspace?purchase=cancelled`;
      const res = await base44.functions.invoke('createTemplateCheckout', {
        templateId: template.id,
        buyerId: user.id,
        buyerEmail: user.email,
        successUrl,
        cancelUrl
      });
      if (res.data?.url) {
        window.location.href = res.data.url;
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBuying(null);
    }
  };

  const uploadIcon = async (file) => {
    if (!file) return;
    setUploadingIcon(true);
    setError('');
    try {
      const { file_url } = await base44.integrations.Core.UploadFile({ file });
      setPublishIcon(file_url);
    } catch (e) {
      setError(e.message);
    } finally {
      setUploadingIcon(false);
    }
  };

  const uploadScreenshot = async (file) => {
    if (!file) return;
    setUploadingShot(true);
    setError('');
    try {
      const { file_url } = await base44.integrations.Core.UploadFile({ file });
      setPublishScreenshots(prev => [...prev, file_url]);
    } catch (e) {
      setError(e.message);
    } finally {
      setUploadingShot(false);
    }
  };

  const copyShareLink = () => {
    if (shareUrl) {
      navigator.clipboard?.writeText(shareUrl);
      setPublishMsg('Share link copied to clipboard!');
    }
  };

  const copyTemplateLink = (template) => {
    const url = `${window.location.origin}/store/${template.id}`;
    navigator.clipboard?.writeText(url);
    setCopiedId(template.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const publish = async () => {
    if (!currentProject) return;
    setPublishing(true);
    setPublishMsg('');
    setShareUrl('');
    setError('');
    try {
      const res = await base44.functions.invoke('publishTemplate', {
        projectId: currentProject.id,
        tags: publishTags,
        category: publishCategory,
        price: Number(publishPrice) || 0,
        icon: publishIcon,
        screenshots: publishScreenshots,
        long_description: publishLongDesc
      });
      setPublishMsg(`Published "${res.data.name}" with ${res.data.fileCount} files${res.data.price > 0 ? ` for $${res.data.price}` : ' (free)'}.`);
      setShareUrl(`${window.location.origin}/store/${res.data.templateId}`);
      setPublishTags('');
      setPublishPrice('0');
      setPublishIcon('');
      setPublishScreenshots([]);
      setPublishLongDesc('');
    } catch (e) {
      setError(e.message);
    } finally {
      setPublishing(false);
    }
  };

  if (!open) return null;

  const fmtPrice = (p) => (p && p > 0 ? `$${Number(p).toFixed(2)}` : 'FREE');

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-3 sm:p-6">
      <div className="w-full max-w-3xl h-[85vh] bg-black border border-primary/40 flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-primary/20 shrink-0">
          <div className="flex items-center gap-2 text-primary font-display tracking-wider">
            <Store size={18} /> MARKETPLACE
          </div>
          <button onClick={onClose} className="text-primary/60 hover:text-primary"><X size={18} /></button>
        </div>

        <div className="flex border-b border-primary/20 shrink-0">
          <button onClick={() => setTab('browse')} className={`flex-1 py-2 text-xs tracking-wider ${tab === 'browse' ? 'bg-primary/10 text-primary' : 'text-primary/40'}`}>BROWSE</button>
          <button onClick={() => setTab('publish')} className={`flex-1 py-2 text-xs tracking-wider ${tab === 'publish' ? 'bg-primary/10 text-primary' : 'text-primary/40'}`} disabled={!currentProject}>PUBLISH</button>
        </div>

        {purchaseMsg && <div className="px-4 py-2 text-xs text-primary border-b border-primary/20 shrink-0 flex items-center gap-2"><CheckCircle2 size={12} /> {purchaseMsg}</div>}
        {error && <div className="px-4 py-2 text-xs text-red-500 border-b border-red-500/20 shrink-0">// {error}</div>}

        {tab === 'browse' ? (
          <>
            <div className="flex flex-col sm:flex-row gap-2 p-3 border-b border-primary/20 shrink-0">
              <div className="flex items-center gap-2 border border-primary/30 px-2 py-1.5 flex-1">
                <Search size={14} className="text-primary/50" />
                <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search constructs..." className="bg-transparent text-primary text-sm outline-none w-full" />
              </div>
              <SheetSelect
                value={category}
                onChange={(v) => setCategory(v)}
                label="CATEGORY"
                options={[{ value: 'all', label: 'all' }, ...categories.map(c => ({ value: c, label: c }))]}
                triggerClassName="text-sm"
              />
            </div>

            <div className="flex-1 overflow-auto scrollbar-matrix p-3 space-y-2">
              {loading ? (
                <div className="flex items-center justify-center h-full text-primary/50"><Loader2 className="animate-spin" size={20} /></div>
              ) : templates.length === 0 ? (
                <div className="text-primary/40 italic text-sm text-center py-8">// no constructs found. be the first.</div>
              ) : templates.map(t => {
                const isPaid = t.price && t.price > 0;
                const canInstall = !isPaid || t.purchased || t.mine;
                return (
                  <div key={t.id} className="border border-primary/30 p-3 hover:border-primary/60 transition-colors">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-primary font-bold">{t.name}</span>
                          {t.mine && <span className="text-[10px] text-primary/50 border border-primary/30 px-1">YOURS</span>}
                          {isPaid && <span className={`text-[10px] px-1.5 py-0.5 border ${t.purchased ? 'text-primary border-primary/50' : 'text-black bg-primary border-primary'}`}>{t.purchased ? 'OWNED' : 'PAID'}</span>}
                        </div>
                        {t.description && <p className="text-primary/60 text-sm mt-1">{t.description}</p>}
                        <div className="flex items-center gap-3 mt-2 text-xs text-primary/40 flex-wrap">
                          <span>by {t.author_name}</span>
                          <span className="uppercase">{t.compile_target}</span>
                          <span>{t.file_count} files</span>
                          <span>{t.install_count} installs</span>
                          {t.category && <span className="border border-primary/20 px-1">{t.category}</span>}
                        </div>
                        {t.tags && <div className="flex items-center gap-1 mt-1 text-xs text-primary/40"><Tag size={10} /> {t.tags}</div>}
                      </div>
                      <div className="flex flex-col items-end gap-1 shrink-0">
                        {isPaid && <span className="text-primary font-bold text-sm">{fmtPrice(t.price)}</span>}
                        {canInstall ? (
                          <button onClick={() => install(t)} disabled={installing === t.id} className="flex items-center gap-1 text-xs text-black bg-primary hover:bg-[#39ff14] px-3 py-1.5 disabled:opacity-50">
                            {installing === t.id ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />} INSTALL
                          </button>
                        ) : (
                          <button onClick={() => buy(t)} disabled={buying === t.id} className="flex items-center gap-1 text-xs text-primary border border-primary hover:bg-primary hover:text-black px-3 py-1.5 disabled:opacity-50">
                            {buying === t.id ? <Loader2 size={12} className="animate-spin" /> : <DollarSign size={12} />} BUY
                          </button>
                        )}
                        <button onClick={() => copyTemplateLink(t)} className="flex items-center gap-1 text-[10px] text-primary/60 hover:text-primary border border-primary/30 hover:border-primary/60 px-2 py-1 transition-colors">
                          {copiedId === t.id ? <><CheckCircle2 size={10} /> COPIED</> : <><Link2 size={10} /> SHARE</>}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div className="flex-1 overflow-auto scrollbar-matrix p-4 space-y-4">
            <p className="text-primary/60 text-sm">// Share "{currentProject?.name}" with the network. Files are cloned as-is. Set a price to charge buyers — you keep 80%, the platform takes 20%.</p>

            {/* Share link after publish */}
            {shareUrl && (
              <div className="border border-primary/40 bg-primary/5 p-3 space-y-2">
                <div className="flex items-center gap-2 text-primary text-sm font-bold"><CheckCircle2 size={14} /> {publishMsg}</div>
                <div className="flex items-center gap-2">
                  <Link2 size={12} className="text-primary/50 shrink-0" />
                  <input readOnly value={shareUrl} className="flex-1 bg-black text-primary text-xs border border-primary/30 px-2 py-1.5 outline-none" />
                  <button onClick={copyShareLink} className="flex items-center gap-1 text-xs text-black bg-primary hover:bg-[#39ff14] px-3 py-1.5 font-bold">
                    <Copy size={12} /> COPY
                  </button>
                </div>
                <p className="text-[10px] text-primary/40">// Share this link with anyone — they can view and buy your app on the public store page.</p>
              </div>
            )}
            {!shareUrl && publishMsg && <div className="text-xs text-primary border border-primary/30 p-2">// {publishMsg}</div>}

            {/* Icon */}
            <div>
              <label className="text-xs text-primary/50 block mb-1">APP ICON / COVER IMAGE</label>
              <div className="flex items-center gap-3">
                <div className="w-16 h-16 border border-primary/30 bg-black flex items-center justify-center overflow-hidden shrink-0">
                  {publishIcon ? <img src={publishIcon} alt="icon" className="w-full h-full object-cover" /> : <ImageIcon size={20} className="text-primary/30" />}
                </div>
                <label className="flex items-center gap-1 text-xs text-primary border border-primary/30 hover:border-primary/60 px-3 py-1.5 cursor-pointer">
                  {uploadingIcon ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />} UPLOAD
                  <input type="file" accept="image/*" className="hidden" onChange={e => uploadIcon(e.target.files?.[0])} />
                </label>
                {publishIcon && <button onClick={() => setPublishIcon('')} className="text-xs text-red-500 hover:text-red-400">REMOVE</button>}
              </div>
            </div>

            {/* Screenshots */}
            <div>
              <label className="text-xs text-primary/50 block mb-1">SCREENSHOTS (shown on store page)</label>
              <div className="flex gap-2 flex-wrap mb-2">
                {publishScreenshots.map((url, i) => (
                  <div key={i} className="relative w-24 h-16 border border-primary/30 bg-black overflow-hidden group">
                    <img src={url} alt={`screenshot ${i + 1}`} className="w-full h-full object-cover" />
                    <button onClick={() => setPublishScreenshots(prev => prev.filter((_, idx) => idx !== i))} className="absolute top-0 right-0 bg-black/80 text-red-500 p-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <X size={10} />
                    </button>
                  </div>
                ))}
                <label className="flex items-center justify-center w-24 h-16 border border-primary/30 hover:border-primary/60 cursor-pointer">
                  {uploadingShot ? <Loader2 size={14} className="animate-spin text-primary/50" /> : <Upload size={14} className="text-primary/50" />}
                  <input type="file" accept="image/*" className="hidden" onChange={e => uploadScreenshot(e.target.files?.[0])} />
                </label>
              </div>
            </div>

            {/* Long description */}
            <div>
              <label className="text-xs text-primary/50 block mb-1">STORE DESCRIPTION (markdown — optional)</label>
              <textarea value={publishLongDesc} onChange={e => setPublishLongDesc(e.target.value)} placeholder="## Features&#10;Describe your app in detail...&#10;&#10;## Installation&#10;How to install and run..." rows={4} className="w-full bg-black text-primary text-sm border border-primary/30 px-2 py-1.5 outline-none resize-y" />
            </div>

            <div>
              <label className="text-xs text-primary/50 block mb-1">PRICE (USD, 0 = free)</label>
              <input type="number" min="0" step="0.01" value={publishPrice} onChange={e => setPublishPrice(e.target.value)} placeholder="0" className="w-full bg-black text-primary text-sm border border-primary/30 px-2 py-1.5 outline-none" />
            </div>
            <div>
              <label className="text-xs text-primary/50 block mb-1">CATEGORY</label>
              <input value={publishCategory} onChange={e => setPublishCategory(e.target.value)} placeholder="general" className="w-full bg-black text-primary text-sm border border-primary/30 px-2 py-1.5 outline-none" />
            </div>
            <div>
              <label className="text-xs text-primary/50 block mb-1">TAGS (comma separated)</label>
              <input value={publishTags} onChange={e => setPublishTags(e.target.value)} placeholder="cli, tool, demo" className="w-full bg-black text-primary text-sm border border-primary/30 px-2 py-1.5 outline-none" />
            </div>
            <button onClick={publish} disabled={publishing} className="flex items-center gap-2 text-xs text-black bg-primary hover:bg-[#39ff14] px-4 py-2 disabled:opacity-50">
              {publishing ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} PUBLISH CONSTRUCT
            </button>
          </div>
        )}
      </div>
    </div>
  );
}