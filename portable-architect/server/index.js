// Express server exposing the Architect API. Drop into any Node app, or run
// standalone:  npm start   (needs Node >= 20, express, jszip)
//
// Env:  ARCHITECT_PORT (4400)  ·  ARCHITECT_DATA_DIR (./.architect-data)
//       ARCHITECT_CORS_ORIGIN (*)  ·  LLM_* (see llm.js)

import express from 'express';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import * as architect from './architect.js';
import { COMPONENTS, DEFAULT_COMPONENTS } from './infrastructure.js';
import { dataDir } from './store.js';

const app = express();
app.use(express.json({ limit: '20mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', process.env.ARCHITECT_CORS_ORIGIN || '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const wrap = (fn) => async (req, res) => {
  try { res.json(await fn(req, res)); }
  catch (e) { res.status(500).json({ error: e.message }); }
};

app.get('/architect/catalog', (req, res) => res.json({ components: COMPONENTS, defaults: DEFAULT_COMPONENTS }));
app.get('/architect/projects', wrap(() => architect.listProjects()));
app.post('/architect/projects', wrap((req) => architect.createProject(req.body || {})));
app.get('/architect/projects/:id', wrap((req) => architect.getProject(req.params.id)));
app.put('/architect/projects/:id/config', wrap((req) => architect.updateConfig(req.params.id, req.body || {})));
app.get('/architect/projects/:id/readiness', wrap((req) => architect.readiness(req.params.id)));
app.post('/architect/projects/:id/plan', wrap((req) => architect.planBackend(req.params.id)));
app.post('/architect/projects/:id/generate', wrap((req) => architect.generateBackend(req.params.id, req.body?.components)));
app.post('/architect/projects/:id/deploy', wrap((req) => architect.deployBackend(req.params.id)));
app.get('/architect/projects/:id/health', wrap((req) => architect.checkDeployHealth(req.params.id)));
app.get('/architect/projects/:id/logs', wrap((req) => architect.getBackendLogs(req.params.id, req.query.platform)));
app.post('/architect/projects/:id/wire', wrap((req) => architect.wireFrontendToBackend(req.params.id)));
app.get('/architect/projects/:id/files', wrap((req) => architect.getFiles(req.params.id)));

app.get('/architect/projects/:id/downloads/:file', async (req, res) => {
  const dir = path.join(dataDir(), 'projects', req.params.id, 'downloads');
  try {
    const buf = await fs.readFile(path.join(dir, req.params.file));
    res.setHeader('Content-Type', 'application/zip');
    return res.send(buf);
  } catch { return res.status(404).json({ error: 'not found' }); }
});

const port = process.env.ARCHITECT_PORT || 4400;
app.listen(port, () => console.log(`Architect server listening on :${port}`));

export default app;