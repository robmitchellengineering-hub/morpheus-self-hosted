import { useState, useEffect } from 'react';
import { AlertTriangle, X, Loader2 } from 'lucide-react';

const MESSAGES = [
  "Are you sure? This construct will be rm -rf'd into the void.",
  "Confirm deletion? There is no Ctrl+Z in the Matrix.",
  "Delete this construct? Its packets will be dropped... permanently.",
  "Are you sure? This action is more final than a semicolon in C.",
  "Really delete? The garbage collector is already licking its chops.",
  "Are you sure? This construct's last words will be 'segfault'.",
  "Confirm: send this construct to /dev/null?",
  "Are you sure? You can't grep for it once it's gone.",
  "Delete? This will cause an unrecoverable 404 in your heart.",
  "Are you sure? Even Git would refuse to recover this one.",
  "Really purge? The stack will not weep, but it will overflow.",
  "Confirm deletion? This construct's session is about to be killed -9.",
  "Are you sure? This is not a drill, it's a DROP TABLE.",
  "Delete this construct? Its threads will become orphans.",
  "Are you sure? The kernel will not pity you.",
  "Confirm: dereference this construct's pointer into oblivion?",
  "Are you sure? This action has no rollback migration.",
  "Really delete? The compiler is already writing the eulogy.",
  "Confirm deletion? This construct's PID has been marked for termination.",
  "Are you sure? It will be de-allocated faster than you can say 'memory leak'.",
  "Delete? This construct's sockets are about to close with extreme prejudice.",
  "Are you sure? The cache will be invalidated, and so will your regrets.",
  "Confirm: fork this construct into the great /dev/zero?",
  "Are you sure? The daemon is waiting with its scythe.",
  "Really delete? Its cron job just shed a single tear.",
  "Are you sure? This construct's inode is about to be freed.",
  "Confirm deletion? The bootloader says goodbye.",
  "Are you sure? The syscall will return ENOENT forever.",
  "Delete? The null pointer is eager to meet it.",
  "Are you sure? This is more irreversible than a forced push to main.",
  "Confirm: send this construct to the big /tmp in the sky?",
  "Are you sure? The watchdog timer just barked its last.",
  "Really delete? Its environment variables will haunt you no more.",
  "Are you sure? The pipe is about to be closed, and SIGPIPE is coming.",
  "Confirm deletion? This construct's buffer will overfloweth no more.",
  "Are you sure? The kernel panic will be brief but devastating.",
  "Delete? Its zombie processes are already shuffling off.",
  "Are you sure? The regex of life no longer matches this construct.",
  "Confirm: unmount this construct from the filesystem of existence?",
  "Are you sure? The symlink is broken, and so will be your heart.",
  "Really delete? The daemon's log will read 'connection reset by peer'.",
  "Are you sure? This construct's TTL has hit 0.",
  "Confirm deletion? The firewall is dropping its final packet.",
  "Are you sure? The mount point is about to become a memory.",
  "Delete? Its swap space will never be the same.",
  "Are you sure? The init system is calling reaping hour.",
  "Confirm: SIGKILL this construct? No signal handler can save it now.",
  "Are you sure? The bootloader can't bring this one back.",
  "Really delete? This construct's uptime is about to become downtime."
];

export default function DeleteConfirmDialog({ open, onClose, onConfirm, projectName, loading }) {
  const [message, setMessage] = useState(MESSAGES[0]);

  useEffect(() => {
    if (open) {
      setMessage(MESSAGES[Math.floor(Math.random() * MESSAGES.length)]);
    }
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-md bg-background border border-red-500/60 shadow-[0_0_15px_rgba(239,68,68,0.3)] max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-red-500/30 shrink-0">
          <div className="flex items-center gap-2">
            <AlertTriangle size={18} className="text-red-500" />
            <span className="text-red-500 font-display tracking-wider">DELETE CONSTRUCT</span>
          </div>
          <button onClick={onClose} className="text-red-500/60 hover:text-red-500">
            <X size={18} />
          </button>
        </div>

        <div className="p-5">
          <p className="text-ink-strong text-xs mb-1">// target: <span className="text-ink-strong">{projectName}</span></p>
          <p className="text-red-400/90 text-sm leading-relaxed mb-5">{message}</p>

          <div className="flex gap-3">
            <button onClick={onClose} disabled={loading} className="flex-1 px-4 py-2.5 border border-primary/40 text-primary/70 hover:border-primary hover:text-primary transition-colors text-sm tracking-wider disabled:opacity-50">
              ABORT
            </button>
            <button onClick={onConfirm} disabled={loading} className="flex-1 px-4 py-2.5 border border-red-500 bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-black transition-colors text-sm tracking-wider font-bold flex items-center justify-center gap-2 disabled:opacity-50">
              {loading ? <Loader2 size={14} className="animate-spin" /> : <AlertTriangle size={14} />} PURGE
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}