import { useGithubConnectionContext } from '@/contexts/GithubConnectionContext';

// Thin re-export kept for the existing call sites (GithubGate,
// ConnectionsDialog, CapabilityStatus). All the state now lives in
// GithubConnectionProvider so those three views stay in sync and share one
// device-flow modal. Return shape is unchanged:
//   { connected, login, loading, connect, disconnect, check }
// plus `device` for anything that wants to reflect flow progress inline.
export function useGithubConnection() {
  return useGithubConnectionContext();
}
