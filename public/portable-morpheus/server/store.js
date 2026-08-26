// File-based JSON store — no database required. All project state lives under
// one data directory so Morpheus is fully self-contained and portable.
//   MORPHEUS_DATA_DIR  – defaults to ./.morpheus-data

import { promises as fs } from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.MORPHEUS_DATA_DIR || path.join(process.cwd(), '.morpheus-data');

async function ensure(p) { await fs.mkdir(path.dirname(p), { recursive: true }); }
async function readJson(rel, fallback) {
  try { return JSON.parse(await fs.readFile(path.join(DATA_DIR, rel), 'utf8')); }
  catch { return fallback; }
}
async function writeJson(rel, data) {
  const full = path.join(DATA_DIR, rel);
  await ensure(full);
  await fs.writeFile(full, JSON.stringify(data, null, 2));
}

export const dataDir = () => DATA_DIR;

export async function listProjects() {
  try {
    const ids = await fs.readdir(path.join(DATA_DIR, 'projects'));
    const rows = await Promise.all(ids.map((id) => readJson(`projects/${id}/project.json`, null)));
    return rows.filter(Boolean);
  } catch { return []; }
}
export const getProject = (id) => readJson(`projects/${id}/project.json`, null);
export const saveProject = (p) => writeJson(`projects/${p.id}/project.json`, p);
export const getFiles = (id) => readJson(`projects/${id}/files.json`, []);
export const saveFiles = (id, files) => writeJson(`projects/${id}/files.json`, files);
export const getMessages = (id) => readJson(`projects/${id}/messages.json`, []);
export const saveMessages = (id, msgs) => writeJson(`projects/${id}/messages.json`, msgs);