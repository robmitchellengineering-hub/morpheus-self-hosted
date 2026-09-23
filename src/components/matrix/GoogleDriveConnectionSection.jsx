import { HardDrive, Check, XCircle, Loader2 } from 'lucide-react';
import { useGoogleDriveConnection } from '@/hooks/useGoogleDriveConnection';

// Account-level Google Drive connection card — mirrors
// GithubConnectionSection.jsx's layout. Per-project storage_mode (whether
// a given project actually mirrors to Drive) lives in ShareDialog.jsx's
// DRIVE tab, not here; this only covers "is an account connected at all",
// same split GitHub already has between this section and per-project repo
// linking.
export default function GoogleDriveConnectionSection() {
  const drive = useGoogleDriveConnection();

  return (
    <section className="border border-primary/30 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <HardDrive size={16} className={drive.connected ? 'text-primary shrink-0' : 'text-primary/50 shrink-0'} />
          <span className="text-sm text-primary">Google Drive</span>
          {drive.loading ? (
            <span className="flex items-center gap-1 text-[10px] text-primary/50 border border-primary/20 px-1.5 py-0.5">
              <Loader2 size={10} className="animate-spin" /> CHECKING
            </span>
          ) : drive.connected ? (
            <span className="flex items-center gap-1 text-[10px] text-primary border border-primary/40 px-1.5 py-0.5 truncate">
              <Check size={10} /> CONNECTED{drive.email ? ` · ${drive.email}` : ''}
            </span>
          ) : (
            <span className="flex items-center gap-1 text-[10px] text-primary/50 border border-primary/20 px-1.5 py-0.5">
              <XCircle size={10} /> DISCONNECTED
            </span>
          )}
        </div>
        {drive.connected ? (
          <button onClick={drive.disconnect} className="text-xs text-red-500/80 hover:text-red-400 border border-red-500/30 px-2.5 py-1.5 min-h-[44px] shrink-0">DISCONNECT</button>
        ) : (
          <button onClick={drive.connect} className="text-xs text-black bg-primary hover:bg-[#39ff14] px-3 py-1.5 min-h-[44px] font-bold flex items-center gap-1 shrink-0">
            <HardDrive size={12} /> CONNECT
          </button>
        )}
      </div>
      <p className="text-[10px] text-ink/50 mt-2">
        // Optional, per project — connect once here, then choose Drive storage for any project in its own Share panel. Postgres stays the default; nothing changes for a project unless you opt it in.
      </p>
    </section>
  );
}
