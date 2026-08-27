import { useState, useEffect } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { Image } from '@/components/ui/image';
import { ArrowLeft, Loader2, Download, DollarSign, CheckCircle2, Tag, FileCode, Calendar, TrendingUp } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import JSZip from 'jszip';
import VerifiedBadge from '@/components/matrix/VerifiedBadge';
import MarketFooter from '@/components/matrix/MarketFooter';
import ShareButton from '@/components/matrix/ShareButton';

export default function StoreItem() {
  const { templateId } = useParams();
  const [searchParams] = useSearchParams();
  const [template, setTemplate] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [buying, setBuying] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [purchaseSessionId, setPurchaseSessionId] = useState(null);

  useEffect(() => {
    const sessionId = searchParams.get('session_id');
    if (searchParams.get('purchase') === 'success' && sessionId) {
      setPurchaseSessionId(sessionId);
      window.history.replaceState({}, '', window.location.pathname);
    }
    loadTemplate();
  }, [templateId]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadTemplate = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await base44.functions.invoke('getPublicTemplate', { templateId });
      setTemplate(res.data);
    } catch (e) {
      setError(e.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  const buy = async () => {
    if (window.self !== window.top) {
      alert('Checkout works only from the published app. Open this page in a new tab to purchase.');
      return;
    }
    setBuying(true);
    setError(null);
    try {
      const origin = window.location.origin;
      const successUrl = `${origin}/store/${templateId}?purchase=success&session_id={CHECKOUT_SESSION_ID}`;
      const cancelUrl = `${origin}/store/${templateId}?purchase=cancelled`;
      const res = await base44.functions.invoke('createTemplateCheckout', {
        templateId,
        successUrl,
        cancelUrl
      });
      if (res.data?.url) {
        window.location.href = res.data.url;
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBuying(false);
    }
  };

  const buildZip = async (filesJson, name) => {
    const files = JSON.parse(filesJson);
    const zip = new JSZip();
    files.forEach(f => zip.file(f.path, f.content));
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const downloadFree = async () => {
    if (!template?.files) return;
    setDownloading(true);
    try {
      await buildZip(template.files, template.name);
    } catch (e) {
      setError(e.message);
    } finally {
      setDownloading(false);
    }
  };

  const downloadPaid = async (retryCount = 0) => {
    if (!purchaseSessionId) return;
    setDownloading(true);
    setError(null);
    try {
      const res = await base44.functions.invoke('downloadTemplate', { sessionId: purchaseSessionId, templateId });
      if (res.data?.files) {
        await buildZip(res.data.files, res.data.name || template.name);
      }
    } catch (e) {
      if (retryCount < 2) {
        // Auto-retry after a short delay — webhook may still be processing
        setTimeout(() => downloadPaid(retryCount + 1), 2000);
        return;
      }
      setError('Payment is being confirmed. Click DOWNLOAD to try again, or contact support if it persists.');
    } finally {
      setDownloading(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <Loader2 className="animate-spin text-primary/50" size={24} />
      </div>
    );
  }

  if (error && !template) {
    return (
      <div className="min-h-screen bg-black flex flex-col items-center justify-center gap-3 px-4">
        <p className="text-red-500 text-sm">// {error}</p>
        <Link to="/market" className="text-primary/60 hover:text-primary text-sm flex items-center gap-1">
          <ArrowLeft size={12} /> Back to Market
        </Link>
      </div>
    );
  }

  const isFree = !template.price || template.price <= 0;
  const fmtPrice = (p) => (p && p > 0 ? `$${Number(p).toFixed(2)}` : 'FREE');
  const purchaseCancelled = searchParams.get('purchase') === 'cancelled';

  return (
    <div className="min-h-screen bg-black text-primary">
      {/* Header */}
      <header className="border-b border-primary/20 sticky top-0 z-10 bg-black/95 backdrop-blur-sm safe-top">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
          <Link to="/market" className="text-xs text-primary/60 hover:text-primary flex items-center gap-1">
            <ArrowLeft size={12} /> MARKET
          </Link>
          <Link to="/" className="text-xs text-primary/60 hover:text-primary">APP</Link>
        </div>
      </header>

      <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
        {/* Purchase success banner */}
        {purchaseSessionId && (
          <div className="border border-primary/40 bg-primary/5 p-4 flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="flex items-start gap-3 flex-1">
              <CheckCircle2 size={20} className="text-primary shrink-0 mt-0.5" />
              <div>
                <p className="text-primary font-bold text-sm">PAYMENT SUCCESSFUL</p>
                <p className="text-primary/60 text-xs mt-1">Your purchase is confirmed. Download your software below.</p>
              </div>
            </div>
            <button
              onClick={downloadPaid}
              disabled={downloading}
              className="flex items-center justify-center gap-2 text-sm text-black bg-primary hover:bg-[#39ff14] px-6 py-2.5 disabled:opacity-50 font-bold sm:w-auto w-full"
            >
              {downloading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} DOWNLOAD
            </button>
          </div>
        )}

        {/* Purchase cancelled banner */}
        {purchaseCancelled && !purchaseSessionId && (
          <div className="border border-yellow-500/40 bg-yellow-500/5 p-3 text-yellow-500 text-sm">
            Payment cancelled. You can try again anytime.
          </div>
        )}

        {/* Hero section */}
        <div className="flex flex-col sm:flex-row gap-4 sm:gap-6">
          <div className="w-24 h-24 sm:w-32 sm:h-32 shrink-0 border border-primary/20 bg-black overflow-hidden flex items-center justify-center">
            {template.icon ? (
              <Image src={template.icon} className="w-full h-full" fittingType="fill" />
            ) : (
              <span className="text-4xl font-display text-primary/65">
                {template.name?.charAt(0)?.toUpperCase() || '?'}
              </span>
            )}
          </div>

          <div className="flex-1 min-w-0 flex flex-col justify-center">
            <h1 className="text-xl sm:text-2xl font-display tracking-wide neon-glow break-words text-heading">{template.name}</h1>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <p className="text-primary/60 text-sm">by {template.author_name}</p>
              <VerifiedBadge />
            </div>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <span className="text-xs text-primary/50 border border-primary/20 px-2 py-0.5 uppercase">
                {template.compile_target?.replace('-', ' ')}
              </span>
              {template.category && template.category !== 'general' && (
                <span className="text-xs text-primary/50 border border-primary/20 px-2 py-0.5 uppercase">
                  {template.category}
                </span>
              )}
            </div>
          </div>

          <div className="flex-col items-stretch sm:items-end gap-4 shrink-0 w-full sm:w-auto">
            <div className="flex items-center justify-between sm:justify-end gap-3">
              <span className={`text-lg font-bold ${isFree ? 'text-primary/60' : 'text-primary'}`}>
                {fmtPrice(template.price)}
              </span>
              {purchaseSessionId ? (
                <button onClick={downloadPaid} disabled={downloading} className="flex items-center gap-2 text-sm text-black bg-primary hover:bg-[#39ff14] px-10 py-2.5 disabled:opacity-50 font-bold">
                  {downloading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} DOWNLOAD
                </button>
              ) : isFree ? (
                <button onClick={downloadFree} disabled={downloading} className="flex items-center gap-2 text-sm text-black bg-primary hover:bg-[#39ff14] px-10 py-2.5 disabled:opacity-50 font-bold">
                  {downloading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} GET
                </button>
              ) : (
                <button onClick={buy} disabled={buying} className="flex items-center gap-2 text-sm text-black bg-primary hover:bg-[#39ff14] px-10 py-2.5 disabled:opacity-50 font-bold">
                  {buying ? <Loader2 size={14} className="animate-spin" /> : <DollarSign size={14} />} BUY
                </button>
              )}
            </div>
            <ShareButton templateId={templateId} label="SHARE" className="w-full sm:w-auto justify-center" />
          </div>
        </div>

        {error && <div className="text-red-500 text-sm">// {error}</div>}

        {/* Screenshots */}
        {template.screenshots?.length > 0 && (
          <div>
            <h2 className="text-xs text-primary/75 uppercase mb-3 tracking-wider">// Screenshots</h2>
            <div className="flex gap-3 overflow-x-auto scrollbar-matrix pb-2 overscroll-none">
              {template.screenshots.map((url, i) => (
                <div key={i} className="shrink-0 w-64 h-40 border border-primary/20 bg-black overflow-hidden">
                  <Image src={url} className="w-full h-full" fittingType="fill" />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Description */}
        {template.description && (
          <div>
            <h2 className="text-xs text-primary/75 uppercase mb-2 tracking-wider">// About</h2>
            <p className="text-primary/80 text-sm leading-relaxed">{template.description}</p>
          </div>
        )}

        {/* Long description */}
        {template.long_description && (
          <div>
            <h2 className="text-xs text-primary/75 uppercase mb-2 tracking-wider">// Details</h2>
            <div className="text-primary/70 text-sm leading-relaxed [&_a]:text-primary [&_a]:underline [&_code]:text-primary [&_code]:bg-primary/10 [&_code]:px-1 [&_h1]:text-primary [&_h2]:text-primary [&_h3]:text-primary [&_li]:text-primary/70 [&_strong]:text-primary">
              <ReactMarkdown>{template.long_description}</ReactMarkdown>
            </div>
          </div>
        )}

        {/* Info grid */}
        <div>
          <h2 className="text-xs text-primary/75 uppercase mb-3 tracking-wider">// Information</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="border border-primary/20 p-3">
              <FileCode size={14} className="text-primary/50 mb-1" />
              <div className="text-xs text-primary/75">Files</div>
              <div className="text-sm text-primary">{template.file_count || 0}</div>
            </div>
            <div className="border border-primary/20 p-3">
              <TrendingUp size={14} className="text-primary/50 mb-1" />
              <div className="text-xs text-primary/75">Installs</div>
              <div className="text-sm text-primary">{template.install_count || 0}</div>
            </div>
            <div className="border border-primary/20 p-3">
              <Calendar size={14} className="text-primary/50 mb-1" />
              <div className="text-xs text-primary/75">Published</div>
              <div className="text-sm text-primary">
                {template.created_date ? new Date(template.created_date).toLocaleDateString() : 'N/A'}
              </div>
            </div>
            <div className="border border-primary/20 p-3">
              <Tag size={14} className="text-primary/50 mb-1" />
              <div className="text-xs text-primary/75">Platform</div>
              <div className="text-sm text-primary uppercase">{template.compile_target?.replace('-', ' ') || 'source'}</div>
            </div>
          </div>
        </div>

        {/* Tags */}
        {template.tags && (
          <div className="flex items-center gap-2 flex-wrap">
            {template.tags.split(',').filter(t => t.trim()).map((tag, i) => (
              <span key={i} className="text-xs text-primary/50 border border-primary/20 px-2 py-1">
                {tag.trim()}
              </span>
            ))}
          </div>
        )}
      </div>
      <MarketFooter />
    </div>
  );
}