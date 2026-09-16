import { useDeckGoogleConnectionContext } from '@/contexts/DeckGoogleConnectionContext';

// Thin re-export, mirroring useGoogleDriveConnection.js.
// Return shape: { connected, email, loading, connect, disconnect, check }
export function useDeckGoogleConnection() {
  return useDeckGoogleConnectionContext();
}
