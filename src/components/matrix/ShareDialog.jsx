import { useState } from 'react';
import { X, Github, Mail, Loader2, CheckCircle, AlertCircle, ExternalLink, Bot, Unlink, DownloadCloud, HardDrive, UploadCloud } from 'lucide-react';
import GithubGate from '@/components/matrix/GithubGate';
import DiagnosisPanel, { DiagnosisLoading } from '@/components/matrix/DiagnosisPanel';
import { useDiagnosis } from '@/hooks/useDiagnosis';
import { useGoogleDriveConnection } from '@/hooks/useGoogleDriveConnection';

export default function ShareDialog({ open, onClose, project, onUploadGithub, onDisconnectGithub, onSyncFromGithub, onSetStorageMode, onPushToDrive, onPullFromDrive, onEmail }) {
  const [tab, setTab] = useState('github');
  const [repoName, setRepoName] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(null);
  const [error, setError] = useState(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const { diagnosis, diagnosing, diagnose } = useDiagnosis();
  const drive = useGoogleDriveConnection();
  const [switchingMode, setSwitchingMode] = useState(false);
  const [driveBusy, setDriveBusy] = useState(false);
  const [driveResult, setDriveResult] = useState(null);
  const [driveError, setDriveError] = useState(null);

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

  const handleDisconnect = async () => {
    setDisconnecting(true); setError(null); setSuccess(null);
    try {
      await onDisconnectGithub();
    } catch (e) {
      setError(e.message);
    } finally {
      setDisconnecting(false);
    }
  };

  const handleSyncFromGithub = async () => {
    setSyncing(true); setError(null); setSyncResult(null);
    try {
      const res = await onSyncFromGithub();
      setSyncResult(res);
    } catch (e) {
      setError(e.message);
    } finally {
      setSyncing(false);
    }
  };

  const handleSwitchStorageMode = async (mode) => {
    setSwitchingMode(true); setDriveError(null); setDriveResult(null);
    try {
      await onSetStorageMode(mode);
    } catch (e) {
      setDriveError(e.message);
    } finally {
      setSwitchingMode(false);
    }
  };

  const handlePushToDrive = async () => {
    setDriveBusy(true); setDriveError(null); setDriveResult(null);
    try {
      setDriveResult(await onPushToDrive());
    } catch (e) {
      setDriveError(e.message);
    } finally {
      setDriveBusy(false);
    }
  };

  const handlePullFromDrive = async () => {
    setDriveBusy(true); setDriveError(null); setDriveResult(null);
    try {
      setDriveResult(await onPullFromDrive());
    } catch (e) {
      setDriveError(e.message);
    } finally {
      setDriveBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={handleClose}>
      <div className="w-full max-w-md border border-primary/40 bg-background p-6 neon-border" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-primary font-display tracking-wider">TRANSMIT CONSTRUCT</h2>
          <button onClick={handleClose} className="text-primary/50 hover:text-primary"><X size={18} /></button>
        </div>

        <div className="flex border border-primary/30 mb-4">
          <button onClick={() => { setTab('github'); setSuccess(null); setError(null); }} className={`flex-1 py-2 text-xs tracking-wider flex items-center justify-center gap-1.5 ${tab === 'github' ? 'bg-primary/10 text-primary' : 'text-primary/75'}`}>
            <Github size={14} /> GITHUB
          </button>
          <button onClick={() => { setTab('drive'); setDriveError(null); setDriveResult(null); }} className={`flex-1 py-2 text-xs tracking-wider flex items-center justify-center gap-1.5 ${tab === 'drive' ? 'bg-primary/10 text-primary' : 'text-primary/75'}`}>
            <HardDrive size={14} /> DRIVE
          </button>
          <button onClick={() => { setTab('email'); setSuccess(null); setError(null); }} className={`flex-1 py-2 text-xs tracking-wider flex items-center justify-center gap-1.5 ${tab === 'email' ? 'bg-primary/10 text-primary' : 'text-primary/75'}`}>
            <Mail size={14} /> EMAIL
          </button>
        </div>

        {success && (
          <div className="mb-4 p-3 border border-primary bg-primary/5 text-primary text-sm flex items-center gap-2">
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
                <button onClick={() => diagnose({ type: 'github', projectId: project.id, errorContext: { error, repoName } })} disabled={diagnosing} className="flex items-center gap-1 text-xs text-primary hover:text-primary px-3 py-2 border border-primary/50 hover:border-primary disabled:opacity-30">
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
              {project?.github_repo && (
                <div className="p-3 border border-primary/40 bg-primary/5 text-sm space-y-2">
                  <div className="flex items-center gap-2 text-primary">
                    <CheckCircle size={14} className="shrink-0" />
                    <span>Synced to</span>
                    <a href={`https://github.com/${project.github_repo}`} target="_blank" rel="noreferrer" className="underline hover:neon-glow flex items-center gap-1 break-all">
                      {project.github_repo} <ExternalLink size={11} className="shrink-0" />
                    </a>
                  </div>
                  <p className="text-ink/50 text-xs">Every chat edit pushes here automatically — no need to re-push manually.</p>
                  <div className="flex items-center gap-3 flex-wrap">
                    <button onClick={handleSyncFromGithub} disabled={syncing} className="flex items-center gap-1.5 text-xs text-primary/60 hover:text-primary disabled:opacity-30">
                      {syncing ? <Loader2 size={12} className="animate-spin" /> : <DownloadCloud size={12} />} Sync from GitHub (pull in edits made directly on the repo)
                    </button>
                    <button onClick={handleDisconnect} disabled={disconnecting} className="flex items-center gap-1.5 text-xs text-primary/60 hover:text-red-400 disabled:opacity-30">
                      {disconnecting ? <Loader2 size={12} className="animate-spin" /> : <Unlink size={12} />} Disconnect (keeps the repo on GitHub)
                    </button>
                  </div>
                  {syncResult && (
                    <p className="text-ink/50 text-xs">
                      Synced {syncResult.fileCount} file(s) at HEAD ({syncResult.fetched} pulled, {syncResult.fileCount - syncResult.fetched} already current)
                      {syncResult.removed ? `, ${syncResult.removed} removed (deleted upstream)` : ''}.
                    </p>
                  )}
                </div>
              )}
              <div>
                <label className="text-xs text-primary/50 uppercase tracking-wider">{project?.github_repo ? 'Push to a different repository' : 'Repository Name'}</label>
                <input value={repoName} onChange={e => setRepoName(e.target.value)} placeholder={slug || 'my-construct'} className="w-full mt-1 bg-transparent border border-primary/30 text-primary px-3 py-2 outline-none focus:border-primary text-sm" autoFocus={!project?.github_repo} />
              </div>
              <label className="flex items-center gap-2 text-sm text-primary/70 cursor-pointer">
                <input type="checkbox" checked={isPrivate} onChange={e => setIsPrivate(e.target.checked)} className="accent-primary" />
                Private repository
              </label>
              <button onClick={handleGithub} disabled={loading} className="w-full py-2 border border-primary text-primary hover:bg-primary hover:text-black disabled:opacity-30 transition-colors font-bold text-sm tracking-wider flex items-center justify-center gap-2">
                {loading ? <Loader2 size={16} className="animate-spin" /> : <Github size={16} />} {project?.github_repo ? 'PUSH TO NEW REPO' : 'PUSH TO GITHUB'}
              </button>
            </div>
          </GithubGate>
        ) : tab === 'drive' ? (
          <div className="space-y-4">
            {!drive.connected ? (
              <div className="p-3 border border-primary/40 bg-primary/5 text-sm space-y-3">
                <p className="text-primary/70">Connect Google Drive to mirror this project's files there instead of (well, alongside — Postgres still keeps a full copy in this phase) Morpheus's own database.</p>
                <button onClick={drive.connect} className="flex items-center gap-1.5 text-xs text-black bg-primary hover:bg-[#39ff14] px-3 py-2 font-bold">
                  <HardDrive size={12} /> CONNECT GOOGLE DRIVE
                </button>
              </div>
            ) : (
              <>
                <div className="p-3 border border-primary/40 bg-primary/5 text-sm space-y-2">
                  <div className="flex items-center gap-2 text-primary">
                    <CheckCircle size={14} className="shrink-0" />
                    <span>Drive connected{drive.email ? ` · ${drive.email}` : ''}</span>
                  </div>
                  <p className="text-ink/50 text-xs">
                    This project is currently in <strong className="text-primary">{project?.storage_mode === 'drive' ? 'Drive' : 'Postgres (default)'}</strong> mode.
                  </p>
                  {project?.storage_mode === 'drive' ? (
                    <button onClick={() => handleSwitchStorageMode('postgres')} disabled={switchingMode} className="flex items-center gap-1.5 text-xs text-primary/60 hover:text-primary disabled:opacity-30">
                      {switchingMode ? <Loader2 size={12} className="animate-spin" /> : null} Switch to Postgres-only
                    </button>
                  ) : (
                    <button onClick={() => handleSwitchStorageMode('drive')} disabled={switchingMode} className="flex items-center gap-1.5 text-xs text-black bg-primary hover:bg-[#39ff14] px-2.5 py-1.5 font-bold disabled:opacity-30">
                      {switchingMode ? <Loader2 size={12} className="animate-spin" /> : <HardDrive size={12} />} Switch this project to Drive
                    </button>
                  )}
                </div>

                {project?.storage_mode === 'drive' && (
                  <div className="p-3 border border-primary/40 bg-primary/5 text-sm space-y-2">
                    <div className="flex items-center gap-3 flex-wrap">
                      <button onClick={handlePushToDrive} disabled={driveBusy} className="flex items-center gap-1.5 text-xs text-primary/60 hover:text-primary disabled:opacity-30">
                        {driveBusy ? <Loader2 size={12} className="animate-spin" /> : <UploadCloud size={12} />} Push to Drive
                      </button>
                      <button onClick={handlePullFromDrive} disabled={driveBusy} className="flex items-center gap-1.5 text-xs text-primary/60 hover:text-primary disabled:opacity-30">
                        {driveBusy ? <Loader2 size={12} className="animate-spin" /> : <DownloadCloud size={12} />} Pull from Drive
                      </button>
                    </div>
                    {driveResult && (
                      <p className="text-ink/50 text-xs">
                        {typeof driveResult.created === 'number'
                          ? `Pushed ${driveResult.totalFiles} file(s) — ${driveResult.created} created, ${driveResult.updated} updated${driveResult.failed ? `, ${driveResult.failed} failed` : ''}.`
                          : `Pulled ${driveResult.fileCount} file(s) — ${driveResult.fetched} fetched${driveResult.removed ? `, ${driveResult.removed} removed` : ''}.`}
                      </p>
                    )}
                  </div>
                )}
              </>
            )}
            {driveError && (
              <div className="p-3 border border-red-500/50 bg-red-500/5 text-red-400 text-sm flex items-start gap-2">
                <AlertCircle size={16} className="shrink-0 mt-0.5" /> <span className="break-words">{driveError}</span>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="text-xs text-primary/50 uppercase tracking-wider">Email Address</label>
              <input value={email} onChange={e => setEmail(e.target.value)} placeholder="operator@matrix.net" type="email" className="w-full mt-1 bg-transparent border border-primary/30 text-primary px-3 py-2 outline-none focus:border-primary text-sm" autoFocus />
            </div>
            <button onClick={handleEmail} disabled={loading || !email.trim()} className="w-full py-2 border border-primary text-primary hover:bg-primary hover:text-black disabled:opacity-30 transition-colors font-bold text-sm tracking-wider flex items-center justify-center gap-2">
              {loading ? <Loader2 size={16} className="animate-spin" /> : <Mail size={16} />} SEND FILES
            </button>
          </div>
        )}
      </div>
    </div>
  );
}