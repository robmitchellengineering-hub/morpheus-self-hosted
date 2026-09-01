import { useState } from 'react';
import { AlertTriangle, Trash2, Loader2, X, Check } from 'lucide-react';
import { base44 } from '@/api/base44Client';

const CONFIRM_PHRASE = 'DELETE';

export default function DangerZone() {
  const [confirming, setConfirming] = useState(false);
  const [typedConfirm, setTypedConfirm] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const handleDelete = async () => {
    setDeleting(true);
    setError('');
    try {
      await base44.functions.invoke('deleteAccount', {});
      setDone(true);
      // Give the user a moment to see the confirmation, then log out
      setTimeout(() => { base44.auth.logout(); }, 1500);
    } catch (e) {
      setError(e.message);
    } finally {
      setDeleting(false);
    }
  };

  if (done) {
    return (
      <section className="mb-8 border border-red-500/50 p-5 bg-red-500/5">
        <div className="flex items-center gap-2 text-red-500">
          <Check size={16} />
          <span className="text-sm font-display tracking-wider">ACCOUNT DATA DELETED</span>
        </div>
        <p className="text-xs text-red-500/70 mt-2">// Logging out... You will be redirected shortly.</p>
      </section>
    );
  }

  return (
    <section className="mb-8 border border-red-500/50 p-5">
      <h2 className="text-sm font-display tracking-wider mb-1 text-red-500 flex items-center gap-2">
        <AlertTriangle size={14} /> DANGER ZONE
      </h2>
      <p className="text-xs text-red-500/60 mb-4">
        // Permanently delete your account and all associated data — projects, files, settings, templates. This cannot be undone.
      </p>

      {!confirming ? (
        <button
          onClick={() => setConfirming(true)}
          className="flex items-center gap-2 px-4 py-2 border border-red-500/50 text-red-500 hover:bg-red-500 hover:text-black transition-colors text-sm font-bold"
        >
          <Trash2 size={14} /> DELETE ACCOUNT
        </button>
      ) : (
        <div className="space-y-3">
          <div className="border border-red-500/30 bg-red-500/5 p-3">
            <p className="text-xs text-red-500/80 mb-2">
              Type <span className="font-bold text-red-500">{CONFIRM_PHRASE}</span> to confirm. All your projects, files, and settings will be permanently erased.
            </p>
            <input
              value={typedConfirm}
              onChange={e => setTypedConfirm(e.target.value)}
              placeholder={CONFIRM_PHRASE}
              className="w-full bg-background text-red-500 border border-red-500/40 px-3 py-2 text-sm outline-none placeholder:text-red-500/20"
            />
          </div>
          {error && <p className="text-xs text-red-500">// {error}</p>}
          <div className="flex gap-2">
            <button
              onClick={handleDelete}
              disabled={deleting || typedConfirm !== CONFIRM_PHRASE}
              className="flex items-center gap-2 px-4 py-2 border border-red-500 text-red-500 hover:bg-red-500 hover:text-black transition-colors text-sm font-bold disabled:opacity-30"
            >
              {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
              {deleting ? 'DELETING...' : 'CONFIRM DELETE'}
            </button>
            <button
              onClick={() => { setConfirming(false); setTypedConfirm(''); setError(''); }}
              className="flex items-center gap-2 px-4 py-2 border border-primary/30 text-primary/60 hover:text-primary transition-colors text-sm"
            >
              <X size={14} /> CANCEL
            </button>
          </div>
        </div>
      )}
    </section>
  );
}