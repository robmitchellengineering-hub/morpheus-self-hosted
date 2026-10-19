import { useGoogleDriveConnectionContext } from '@/contexts/GoogleDriveConnectionContext';

// Thin re-export, mirroring useGithubConnection.js. Return shape:
//   { connected, email, loading, connect, disconnect, check }
export function useGoogleDriveConnection() {
  return useGoogleDriveConnectionContext();
}
