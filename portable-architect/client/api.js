// Framework-agnostic fetch client for the Architect server.
// Set window.ARCHITECT_API_BASE (or define ARCHITECT_API_BASE) to your
// deployed Architect server URL. Defaults to same-origin /architect.

const BASE = (typeof window !== 'undefined' && window.ARCHITECT_API_BASE) || '/architect';

async function req(p, opts = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  catalog: () => req('/catalog'),
  listProjects: () => req('/projects'),
  createProject: (body) => req('/projects', { method: 'POST', body }),
  getProject: (id) => req(`/projects/${id}`),
  updateConfig: (id, body) => req(`/projects/${id}/config`, { method: 'PUT', body }),
  readiness: (id) => req(`/projects/${id}/readiness`),
  plan: (id) => req(`/projects/${id}/plan`, { method: 'POST' }),
  generate: (id, components) => req(`/projects/${id}/generate`, { method: 'POST', body: { components } }),
  deploy: (id) => req(`/projects/${id}/deploy`, { method: 'POST' }),
  health: (id) => req(`/projects/${id}/health`),
  logs: (id, platform) => req(`/projects/${id}/logs?platform=${platform || ''}`),
  wire: (id) => req(`/projects/${id}/wire`, { method: 'POST' }),
  files: (id) => req(`/projects/${id}/files`),
};