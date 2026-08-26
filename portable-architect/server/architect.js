// Core orchestrator: plan → generate → deploy → health → logs → wire.
// Framework-agnostic; uses the LLM client + file store + deployers.

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { chat } from './llm.js';
import { COMPONENTS, DEFAULT_COMPONENTS, getServiceOption, getDeployExpectation } from './infrastructure.js';
import { getProject, saveProject, getPlan, savePlan, getFiles, saveFiles, getDeploy, saveDeploy, getConfig, saveConfig, dataDir } from './store.js';
import { checkHealth } from './health.js';
import { deploy as deployService, getLogPointer } from './deployers.js';
import { wireFrontend } from './wire.js';

export { listProjects, getProject, getFiles } from './store.js';

const slug = (name) => (name || 'app').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'app';
const labelFor = (t) => ({ api_host: 'API Host', database: 'Database', auth: 'Auth', file_storage: 'File Storage', cache: 'Cache' }[t] || t);

export async function createProject({ name, description = '', frontendConfig = {}, connections = {}, components }) {
  const id = randomUUID();
  const project = { id, name, description, createdDate: new Date().toISOString(), status: 'init' };
  await saveProject(project);
  await saveConfig(id, { components: components || DEFAULT_COMPONENTS, frontendConfig, connections });
  return project;
}

export async function updateConfig(projectId, patch) {
  const config = (await getConfig(projectId)) || {};
  const next = { ...config, ...patch };
  await saveConfig(projectId, next);
  return next;
}

export async function planBackend(projectId) {
  const project = await getProject(projectId);
  const config = await getConfig(projectId);
  const prompt = `Project: ${project.name}\nDescription: ${project.description}\n\nFrontend config (functions the app needs, connections configured):\n${JSON.stringify(config.frontendConfig || {}, null, 2)}\n\nSelected infrastructure:\n${JSON.stringify(config.components || DEFAULT_COMPONENTS, null, 2)}\n\nProduce a JSON backend architecture plan with this exact shape:\n{\n  "summary": string,\n  "database": { "tables": [{ "name": string, "columns": [{ "name": string, "type": string }] }] },\n  "api": { "routes": [{ "method": "GET|POST|PUT|DELETE", "path": string, "description": string }] },\n  "auth": { "strategy": string },\n  "storage": { "type": string },\n  "recommendations": string\n}`;
  const plan = await chat(
    [
      { role: 'system', content: 'You are a backend architect. Given a frontend app description and its configured functions/connections, produce a concrete backend architecture plan as JSON only.' },
      { role: 'user', content: prompt },
    ],
    { json: true }
  );
  plan.components = plan.components || Object.entries(config.components || DEFAULT_COMPONENTS).map(([type, suggested]) => ({ type, suggested, reason: 'User-configured' }));
  await savePlan(projectId, plan);
  await saveProject({ ...project, status: 'planned' });
  return plan;
}

export async function generateBackend(projectId, components) {
  const project = await getProject(projectId);
  const plan = await getPlan(projectId);
  const config = await getConfig(projectId);
  if (components) { config.components = components; await saveConfig(projectId, config); }
  const isWorker = config.components.api_host === 'cloudflare-workers';
  const prompt = `Generate the complete backend for this project as JSON: { "files": [{ "path": string, "content": string }], "summary": string }.\nProject: ${project.name}\nPlan:\n${JSON.stringify(plan, null, 2)}\nInfrastructure:\n${JSON.stringify(config.components, null, 2)}\nAvailable connection keys: ${JSON.stringify(Object.keys(config.connections || {}))}\n\nRules:\n- ${isWorker ? 'Target is Cloudflare Workers: produce a single worker.js in service-worker format (addEventListener fetch) plus a wrangler.toml and package.json.' : 'Target is Node/Express: produce server.js, routes/, db/, package.json, .env.example, README.md.'}\n- Include a SQL migration file (schema.sql) for the chosen database.\n- Read every secret from env vars (never hardcode credentials).\n- Production-ready, complete code — no placeholders.\n- Return ONLY the JSON object.`;
  const res = await chat(
    [
      { role: 'system', content: 'You are a senior backend engineer. Generate complete, production-ready backend code as a JSON file set.' },
      { role: 'user', content: prompt },
    ],
    { json: true, maxTokens: 4000 }
  );
  const files = Array.isArray(res.files) ? res.files : [];
  await saveFiles(projectId, files);
  await saveProject({ ...project, status: 'generated' });
  return { files, summary: res.summary || `Generated ${files.length} backend files.` };
}

export async function deployBackend(projectId) {
  const project = await getProject(projectId);
  const config = await getConfig(projectId);
  const files = await getFiles(projectId);
  const results = [];
  for (const [type, serviceId] of Object.entries(config.components)) {
    const opt = getServiceOption(type, serviceId);
    try {
      const r = await deployService(serviceId, { serviceId, type, projectName: project.name, files, connections: config.connections });
      results.push({ component: labelFor(type), label: opt?.label, service: serviceId, ...r });
    } catch (e) {
      results.push({ component: labelFor(type), label: opt?.label, service: serviceId, status: 'error', message: e.message });
    }
  }
  // Persist ZIP packages to disk and expose a download URL.
  for (const r of results) {
    if (r.zipBuffer) {
      const dir = path.join(dataDir(), 'projects', projectId, 'downloads');
      await fs.mkdir(dir, { recursive: true });
      const fn = `${slug(project.name)}-${r.service}.zip`;
      await fs.writeFile(path.join(dir, fn), r.zipBuffer);
      r.zipUrl = `/architect/projects/${projectId}/downloads/${fn}`;
      delete r.zipBuffer;
    }
  }
  await saveDeploy(projectId, { results, date: new Date().toISOString() });
  await saveProject({ ...project, status: 'deployed' });
  return results;
}

export async function checkDeployHealth(projectId) {
  const deploy = await getDeploy(projectId);
  const live = (deploy?.results || []).find((r) => r.url);
  if (!live) return { healthy: false, error: 'No live-deployed URL found. Run DEPLOY first.' };
  return checkHealth(live.url);
}

export async function getBackendLogs(projectId, platform) {
  const config = await getConfig(projectId);
  const deploy = await getDeploy(projectId);
  const serviceId = platform || config.components.api_host;
  const dashboardUrl = getLogPointer(serviceId, config.connections);
  const stored = (deploy?.results || []).filter((r) => r.service === serviceId).flatMap((r) => [r.message, r.configMessage].filter(Boolean));
  return { platform: serviceId, dashboardUrl, logs: stored };
}

export async function wireFrontendToBackend(projectId) {
  const deploy = await getDeploy(projectId);
  const live = (deploy?.results || []).find((r) => r.url);
  if (!live) return { error: 'No live backend URL to wire to. Deploy first.' };
  const files = await getFiles(projectId);
  const result = wireFrontend(files, live.url);
  await saveFiles(projectId, files);
  return result;
}

export async function readiness(projectId) {
  const config = await getConfig(projectId);
  return Object.entries(config.components).map(([type, serviceId]) => ({
    type, serviceId, label: getServiceOption(type, serviceId)?.label, ...getDeployExpectation(serviceId, config.connections),
  }));
}

export { COMPONENTS, DEFAULT_COMPONENTS };