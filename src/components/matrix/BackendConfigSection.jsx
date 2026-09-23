import { useState, useEffect } from 'react';
import { Globe, Key, Plus, Copy, Check, Trash2, Loader2, AlertTriangle, RefreshCw } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import DnsSetupGuide from './DnsSetupGuide';

export default function BackendConfigSection({ projectId, apiHostService }) {
  const [customDomain, setCustomDomain] = useState('');
  const [domainInput, setDomainInput] = useState('');
  const [apiKeys, setApiKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [savingDomain, setSavingDomain] = useState(false);
  const [generatingKey, setGeneratingKey] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKey, setNewKey] = useState(null);
  const [copied, setCopied] = useState(false);
  const [revokingId, setRevokingId] = useState(null);
  const [error, setError] = useState('');

  const loadConfig = async () => {
    try {
      const res = await base44.functions.invoke('manageBackendConfig', { projectId, action: 'get' });
      setCustomDomain(res.data.custom_domain || '');
      setDomainInput(res.data.custom_domain || '');
      setApiKeys(res.data.api_keys || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (projectId) loadConfig();
  }, [projectId]);

  const saveDomain = async () => {
    setSavingDomain(true);
    setError('');
    try {
      await base44.functions.invoke('manageBackendConfig', { projectId, action: 'set_domain', custom_domain: domainInput });
      setCustomDomain(domainInput.trim().replace(/^https?:\/\//, '').replace(/\/$/, ''));
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingDomain(false);
    }
  };

  const generateKey = async () => {
    setGeneratingKey(true);
    setError('');
    setNewKey(null);
    try {
      const res = await base44.functions.invoke('manageBackendConfig', { projectId, action: 'generate_key', name: newKeyName || 'Default' });
      setNewKey(res.data.key);
      setNewKeyName('');
      await loadConfig();
    } catch (e) {
      setError(e.message);
    } finally {
      setGeneratingKey(false);
    }
  };

  const revokeKey = async (keyId) => {
    setRevokingId(keyId);
    setError('');
    try {
      await base44.functions.invoke('manageBackendConfig', { projectId, action: 'revoke_key', keyId });
      await loadConfig();
    } catch (e) {
      setError(e.message);
    } finally {
      setRevokingId(null);
    }
  };

  const copyKey = (key) => {
    navigator.clipboard.writeText(key);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (loading) {
    return <div className="flex items-center gap-2 text-ink/75 text-xs py-2"><Loader2 size={12} className="animate-spin" /> Loading backend config...</div>;
  }

  const activeKeys = apiKeys.filter(k => k.active);

  return (
    <div className="border border-primary/20 p-3 space-y-4">
      <div className="text-xs text-primary/75 uppercase flex items-center gap-1.5">
        <Key size={12} /> // custom domain & api keys
      </div>

      {error && <p className="text-red-500 text-xs">// {error}</p>}

      {/* Custom Domain */}
      <div>
        <label className="block text-xs text-primary/60 uppercase tracking-wider mb-1 flex items-center gap-1.5">
          <Globe size={12} /> Custom Domain
        </label>
        <div className="flex gap-2">
          <input
            value={domainInput}
            onChange={e => setDomainInput(e.target.value)}
            placeholder="api.myapp.com"
            className="flex-1 bg-background text-primary border border-primary/30 px-3 py-2 text-sm outline-none placeholder:text-primary/20"
          />
          <button
            onClick={saveDomain}
            disabled={savingDomain || domainInput === customDomain}
            className="flex items-center gap-1 px-3 py-2 border border-primary/40 text-primary hover:bg-primary hover:text-black transition-colors text-xs font-bold disabled:opacity-30"
          >
            {savingDomain ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} SET
          </button>
        </div>
        <p className="text-[10px] text-ink/65 mt-1">
          // Auto-applied on deploy for Cloudflare Workers + Vercel. Render / Railway / Fly / Netlify: step-by-step DNS instructions shown in deploy results.
        </p>
        {customDomain && (
          <p className="text-[10px] text-ink/50 mt-1 flex items-center gap-1">
            <Check size={10} className="text-primary" /> Active: <span className="text-ink">{customDomain}</span>
          </p>
        )}
      </div>

      {/* API Keys */}
      <div>
        <label className="block text-xs text-primary/60 uppercase tracking-wider mb-1 flex items-center gap-1.5">
          <Key size={12} /> API Keys ({activeKeys.length} active)
        </label>
        <p className="text-[10px] text-ink/65 mb-2">
          // Keys are injected as env vars on deploy. The backend validates incoming requests against them. Full key shown only once — copy it now.
        </p>

        {/* Generate new key */}
        <div className="flex gap-2 mb-2">
          <input
            value={newKeyName}
            onChange={e => setNewKeyName(e.target.value)}
            placeholder="Key name (e.g. Mobile App)"
            className="flex-1 bg-background text-primary border border-primary/30 px-3 py-2 text-sm outline-none placeholder:text-primary/20"
          />
          <button
            onClick={generateKey}
            disabled={generatingKey}
            className="flex items-center gap-1 px-3 py-2 border border-primary/40 text-primary hover:bg-primary hover:text-black transition-colors text-xs font-bold disabled:opacity-30"
          >
            {generatingKey ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} GENERATE
          </button>
        </div>

        {/* Newly generated key — shown once */}
        {newKey && (
          <div className="border border-yellow-500/40 bg-yellow-500/5 p-2 mb-2">
            <div className="flex items-center gap-1 text-yellow-500 text-xs mb-1">
              <AlertTriangle size={12} /> COPY NOW — shown only once
            </div>
            <div className="flex gap-2">
              <code className="flex-1 text-xs text-ink font-mono break-all bg-black/50 px-2 py-1.5 border border-primary/20">{newKey}</code>
              <button onClick={() => copyKey(newKey)} className="px-3 border border-primary/30 text-primary hover:bg-primary hover:text-black">
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
          </div>
        )}

        {/* Key list */}
        {apiKeys.length > 0 ? (
          <div className="space-y-1">
            {apiKeys.map(k => (
              <div key={k.id} className={`flex items-center gap-2 px-2 py-1.5 border ${k.active ? 'border-primary/20' : 'border-primary/10 opacity-40'}`}>
                <Key size={12} className={k.active ? 'text-primary' : 'text-primary/65'} />
                <span className="text-xs text-ink/70 flex-1 truncate">{k.name}</span>
                <code className="text-xs text-ink/50 font-mono">{k.prefix}...</code>
                <span className={`text-[9px] uppercase px-1 ${k.active ? 'text-primary' : 'text-primary/65'}`}>{k.active ? 'ACTIVE' : 'REVOKED'}</span>
                {k.active && (
                  <button
                    onClick={() => revokeKey(k.id)}
                    disabled={revokingId === k.id}
                    className="text-red-500/60 hover:text-red-500 disabled:opacity-30"
                    title="Revoke"
                  >
                    {revokingId === k.id ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[10px] text-ink/65">// No API keys yet. Generate one to secure your backend endpoints.</p>
        )}
      </div>

      <div className="flex items-center gap-1.5 text-[10px] text-ink/65 pt-1 border-t border-primary/10">
        <RefreshCw size={10} /> Redeploy after changes to apply custom domain and API keys to the live backend.
      </div>

      {/* Platform-specific DNS setup guide — collapsible */}
      <DnsSetupGuide service={apiHostService} />
    </div>
  );
}