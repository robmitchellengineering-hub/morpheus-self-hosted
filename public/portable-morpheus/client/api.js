// Framework-agnostic fetch client for the Morpheus server.
// Set window.MORPHEUS_API_BASE (or define MORPHEUS_API_BASE) to your
// deployed Morpheus server URL. Defaults to same-origin /morpheus.

const BASE = (typeof window !== 'undefined' && window.MORPHEUS_API_BASE) || '/morpheus';

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
  listProjects: () => req('/projects'),
  createProject: (body) => req('/projects', { method: 'POST', body }),
  getProject: (id) => req(`/projects/${id}`),
  deleteProject: (id) => req(`/projects/${id}`, { method: 'DELETE' }),
  files: (id) => req(`/projects/${id}/files`),
  messages: (id) => req(`/projects/${id}/messages`),
  chat: (id, message, fileUrls) => req(`/projects/${id}/chat`, { method: 'POST', body: { message, fileUrls } }),
  zipUrl: (id) => `${BASE}/projects/${id}/zip`,
};