// Express server exposing the Morpheus API. Drop into any Node app, or run
// standalone:  npm start   (needs Node >= 20, express, jszip)
//
// Env:  MORPHEUS_PORT (4500)  ·  MORPHEUS_DATA_DIR (./.morpheus-data)
//       MORPHEUS_CORS_ORIGIN (*)  ·  LLM_* (see llm.js)

import express from 'express';
import JSZip from 'jszip';
import * as morpheus from './morpheus.js';
import { getProject, getFiles, getMessages } from './store.js';

const app = express();
app.use(express.json({ limit: '20mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', process.env.MORPHEUS_CORS_ORIGIN || '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const wrap = (fn) => async (req, res) => {
  try { res.json(await fn(req, res)); }
  catch (e) { res.status(500).json({ error: e.message }); }
};

app.get('/morpheus/projects', wrap(() => morpheus.listProjects()));
app.post('/morpheus/projects', wrap((req) => morpheus.createProject(req.body || {})));
app.get('/morpheus/projects/:id', wrap(async (req) => {
  const project = await getProject(req.params.id);
  if (!project) return { error: 'not found' };
  return { project, files: await getFiles(req.params.id), messages: await getMessages(req.params.id) };
}));
app.delete('/morpheus/projects/:id', wrap((req) => morpheus.deleteProject(req.params.id)));
app.get('/morpheus/projects/:id/files', wrap((req) => getFiles(req.params.id)));
app.get('/morpheus/projects/:id/messages', wrap((req) => getMessages(req.params.id)));
app.post('/morpheus/projects/:id/chat', wrap(async (req) => {
  const { message, fileUrls } = req.body || {};
  if (!message) throw new Error('message required');
  return morpheus.chatWithProject(req.params.id, message, fileUrls);
}));

app.get('/morpheus/projects/:id/zip', wrap(async (req, res) => {
  const project = await getProject(req.params.id);
  if (!project) { res.status(404).json({ error: 'not found' }); return; }
  const files = await getFiles(req.params.id);
  const zip = new JSZip();
  for (const f of files) zip.file(f.path, f.content);
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  const slug = (project.name || 'app').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'app';
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${slug}.zip"`);
  res.send(buf);
}));

const port = process.env.MORPHEUS_PORT || 4500;
app.listen(port, () => console.log(`Morpheus server listening on :${port}`));

export default app;