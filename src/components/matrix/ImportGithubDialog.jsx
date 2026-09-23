import { useState } from 'react';
import { X, Github, Loader2 } from 'lucide-react';
import GithubGate from '@/components/matrix/GithubGate';
import SheetSelect from '@/components/matrix/SheetSelect';

export default function ImportGithubDialog({ open, onClose, onImport }) {
  const [repoInput, setRepoInput] = useState('');
  const [target, setTarget] = useState('source');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  if (!open) return null;

  const handleImport = async () => {
    if (!repoInput.trim() || loading) return;
    setLoading(true);
    setError('');
    try {
      await onImport(repoInput.trim(), target);
      setRepoInput('');
      setTarget('source');
    } catch (e) {
      setError(e.message || 'Import failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div className="w-full max-w-md border border-primary/40 bg-background p-6 neon-border" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-primary font-display tracking-wider flex items-center gap-2">
            <Github size={18} /> IMPORT CONSTRUCT
          </h2>
          <button onClick={onClose} className="text-primary/50 hover:text-primary"><X size={18} /></button>
        </div>
        <GithubGate note="Connect your GitHub account to import a repo into the Matrix.">
          <div className="space-y-4">
            <div>
              <label className="text-xs text-primary/50 uppercase tracking-wider">Repository</label>
              <input
                value={repoInput}
                onChange={e => setRepoInput(e.target.value)}
                placeholder="owner/repo or https://github.com/owner/repo"
                className="w-full mt-1 bg-transparent border border-primary/30 text-ink px-3 py-2 outline-none focus:border-primary text-sm"
                autoFocus
                onKeyDown={e => e.key === 'Enter' && handleImport()}
              />
              <p className="text-xs text-ink-strong mt-1">// Pull an existing repo into the Matrix</p>
            </div>
            <div>
              <label className="text-xs text-primary/50 uppercase tracking-wider">Compile Target</label>
              <SheetSelect
                value={target}
                onChange={setTarget}
                label="COMPILE TARGET"
                triggerClassName="w-full mt-1"
                options={[
                  { value: 'source', label: 'Source code only' },
                  { value: 'windows-exe', label: 'Windows .exe' },
                  { value: 'mac-app', label: 'macOS .app' },
                  { value: 'linux-binary', label: 'Linux binary' },
                  { value: 'android-apk', label: 'Android APK' },
                  { value: 'ios-app', label: 'iOS app' },
                  { value: 'python-package', label: 'Python package' },
                  { value: 'web-app', label: 'Web app' },
                  { value: 'rpi-distro', label: 'Raspberry Pi distro' },
                  { value: 'arduino-firmware', label: 'Arduino firmware' },
                ]}
              />
            </div>
            {error && <p className="text-xs text-red-400">// {error}</p>}
            <button
              onClick={handleImport}
              disabled={!repoInput.trim() || loading}
              className="w-full py-2 border border-primary text-primary hover:bg-primary hover:text-black disabled:opacity-30 transition-colors font-bold text-sm tracking-wider flex items-center justify-center gap-2"
            >
              {loading ? <><Loader2 size={16} className="animate-spin" /> JACKING IN...</> : <><Github size={16} /> IMPORT</>}
            </button>
          </div>
        </GithubGate>
      </div>
    </div>
  );
}