import { useState } from 'react';
import { X, Github, Mail, Loader2, CheckCircle, AlertCircle, ExternalLink, Bot } from 'lucide-react';
import GithubGate from '@/components/matrix/GithubGate';
import DiagnosisPanel, { DiagnosisLoading } from '@/components/matrix/DiagnosisPanel';
import { useDiagnosis } from '@/hooks/useDiagnosis';

export default function ShareDialog({ open, onClose, project, onUploadGithub, onEmail }) {
  const [tab, setTab] = useState('github');
  const [repoName, setRepoName] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(null);
  const [error, setError] = useState(null);
  const { diagnosis, diagnosing, diagnose } = useDiagnosis();

  if (!open) return null;

  const slug = (project?.name || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

  const handleGithub = async () => {
    setLoading(true); setError(null); setSuccess(null);
    try {
      const res = await onUploadGithub(repoName || slug, isPrivate);
      setSuccess(res?.repoUrl || 'Uploaded');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleEmail = async () => {
    setLoading(true); setError(null); setSuccess(null);
    try {
      await onEmail(email);
      setSuccess('Email sent. Check your inbox.');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setSuccess(null); setError(null); setRepoName(''); setEmail('');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={handleClose}>
      <div className="w-full max-w-md border border-[#00ff41]/40 bg-black p-6 neon-border" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[#00ff41] font-display tracking-wider">TRANSMIT CONSTRUCT</h2>
          <button onClick={handleClose} className="text-[#00ff41]/50 hover:text-[#00ff41]"><X size={18} /></button>
        </div>

        <div className="flex border border-[#00ff41]/30 mb-4">
          <button onClick={() => { setTab('github'); setSuccess(null); setError(null); }} className={`flex-1 py-2 text-xs tracking-wider flex items-center justify-center gap-1.5 ${tab === 'github' ? 'bg-[#00ff41]/10 text-[#00ff41]' : 'text-[#00ff41]/75'}`}>
            <Github size={14} /> GITHUB
          </button>
          <button onClick={() => { setTab('email'); setSuccess(null); setError(null); }} className={`flex-1 py-2 text-xs tracking-wider flex items-center justify-center gap-1.5 ${tab === 'email' ? 'bg-[#00ff41]/10 text-[#00ff41]' : 'text-[#00ff41]/75'}`}>
            <Mail size={14} /> EMAIL
          </button>
        </div>

        {success && (
          <div className="mb-4 p-3 border border-[#00ff41] bg-[#00ff41]/5 text-[#00ff41] text-sm flex items-center gap-2">
            <CheckCircle size={16} className="shrink-0" />
            {tab === 'github' && typeof success === 'string' && success.startsWith('http') ? (
              <a href={success} target="_blank" rel="noreferrer" className="underline hover:neon-glow flex items-center gap-1 break-all">
                {success} <ExternalLink size={12} className="shrink-0" />
              </a>
            ) : (
              <span>{success}</span>
            )}
          </div>
        )}
        {error && (
          <div className="mb-4 space-y-2">
            <div className="p-3 border border-red-500/50 bg-red-500/5 text-red-400 text-sm flex items-start gap-2">
              <AlertCircle size={16} className="shrink-0 mt-0.5" /> <span className="break-words">{error}</span>
            </div>
            {tab === 'github' && (
              <div className="space-y-2">
                <button onClick={() => diagnose({ type: 'github', projectId: project.id, errorContext: { error, repoName } })} disabled={diagnosing} className="flex items-center gap-1 text-xs text-[#00ff41] hover:text-[#00ff41] px-3 py-2 border border-[#00ff41]/50 hover:border-[#00ff41] disabled:opacity-30">
                  {diagnosing ? <Loader2 size={12} className="animate-spin" /> : <Bot size={12} />} AI DIAGNOSE & FIX
                </button>
                {diagnosing && <DiagnosisLoading label="AI AGENT ANALYZING GITHUB ERROR..." />}
                {diagnosis && !diagnosing && <DiagnosisPanel diagnosis={diagnosis} onRedeploy={() => handleGithub()} redeployLabel="RETRY PUSH" />}
              </div>
            )}
          </div>
        )}

        {tab === 'github' ? (
          <GithubGate note="Connect your GitHub account to push this construct to your own repo.">
            <div className="space-y-4">
              <div>
                <label className="text-xs text-[#00ff41]/50 uppercase tracking-wider">Repository Name</label>
                <input value={repoName} onChange={e => setRepoName(e.target.value)} placeholder={slug || 'my-construct'} className="w-full mt-1 bg-transparent border border-[#00ff41]/30 text-[#00ff41] px-3 py-2 outline-none focus:border-[#00ff41] text-sm" autoFocus />
              </div>
              <label className="flex items-center gap-2 text-sm text-[#00ff41]/70 cursor-pointer">
                <input type="checkbox" checked={isPrivate} onChange={e => setIsPrivate(e.target.checked)} className="accent-[#00ff41]" />
                Private repository
              </label>
              <button onClick={handleGithub} disabled={loading} className="w-full py-2 border border-[#00ff41] text-[#00ff41] hover:bg-[#00ff41] hover:text-black disabled:opacity-30 transition-colors font-bold text-sm tracking-wider flex items-center justify-center gap-2">
                {loading ? <Loader2 size={16} className="animate-spin" /> : <Github size={16} />} PUSH TO GITHUB
              </button>
            </div>
          </GithubGate>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="text-xs text-[#00ff41]/50 uppercase tracking-wider">Email Address</label>
              <input value={email} onChange={e => setEmail(e.target.value)} placeholder="operator@matrix.net" type="email" className="w-full mt-1 bg-transparent border border-[#00ff41]/30 text-[#00ff41] px-3 py-2 outline-none focus:border-[#00ff41] text-sm" autoFocus />
            </div>
            <button onClick={handleEmail} disabled={loading || !email.trim()} className="w-full py-2 border border-[#00ff41] text-[#00ff41] hover:bg-[#00ff41] hover:text-black disabled:opacity-30 transition-colors font-bold text-sm tracking-wider flex items-center justify-center gap-2">
              {loading ? <Loader2 size={16} className="animate-spin" /> : <Mail size={16} />} SEND FILES
            </button>
          </div>
        )}
      </div>
    </div>
  );
}