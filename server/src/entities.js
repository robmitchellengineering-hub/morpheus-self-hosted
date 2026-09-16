// Generic entity CRUD engine — the REST equivalent of the Base44 SDK's
// `base44.entities.X.{list,filter,get,create,update,delete,deleteMany,bulkCreate}`.
//
// Every model in prisma/schema.prisma carries created_by_id (owner scoping,
// same as the original RLS: `{ "created_by_id": "{{user.id}}" }` in every
// base44/entities/*.jsonc), so a single generic handler works for all 11
// entities and the frontend's existing base44.entities.* call sites need no
// changes — only src/api/base44Client.js (the shim) needs to speak this API.
//
// Admins bypass owner scoping (RLS also had a `user_condition: role=admin`
// branch on most entities). Template rows are additionally readable by
// anyone when fetched through the dedicated marketplace functions
// (browseTemplates/getPublicTemplate) — NOT through this generic API, which
// always scopes to the caller, matching how Base44 functions used
// `asServiceRole` to intentionally bypass RLS for public listings.
import { prisma } from './db.js';

// Map REST entity name (PascalCase, matches base44 entity name / Prisma model name)
// to the Prisma delegate key (camelCase).
const ENTITY_MAP = {
  Project: 'project',
  ProjectFile: 'projectFile',
  ChatMessage: 'chatMessage',
  FileSnapshot: 'fileSnapshot',
  UsageRecord: 'usageRecord',
  Template: 'template',
  Purchase: 'purchase',
  UserSettings: 'userSettings',
  BackendConfig: 'backendConfig',
  RebuildDoc: 'rebuildDoc',
  SelfDevManual: 'selfDevManual',
  UpdatesPlan: 'updatesPlan',
  CostSnapshot: 'costSnapshot',
  GithubConnection: 'githubConnection',
  // Owner/Admin Control Panel (Feature Backlog #8) — simple owner-scoped
  // punch-list rows, admin bypasses scoping same as everything else here.
  // PlatformSetting, AdminAuditLog and ModelCatalogEntry are deliberately
  // NOT in this map — they're served by bespoke, audited routes in
  // admin.routes.js instead (see schema.prisma's AdminAuditLog comment).
  MaintenanceTask: 'maintenanceTask',
  // Command Deck (internal codename "Deck" — see schema.prisma's comment
  // above these models for why, and why it's not just "Command Deck").
  DeckJarvisMessage: 'deckJarvisMessage',
  DeckDumpItem: 'deckDumpItem',
  DeckPerson: 'deckPerson',
  DeckTask: 'deckTask',
  DeckConsignmentItem: 'deckConsignmentItem',
  DeckRepairJob: 'deckRepairJob',
  DeckRepairFile: 'deckRepairFile',
  DeckMurbahOpportunity: 'deckMurbahOpportunity',
  DeckInboxItem: 'deckInboxItem',
  DeckStrategyNote: 'deckStrategyNote',
  DeckKnowledgeNote: 'deckKnowledgeNote',
  DeckLifeStream: 'deckLifeStream',
  DeckLifeStreamNote: 'deckLifeStreamNote',
  DeckEnergyLogEntry: 'deckEnergyLogEntry',
  DeckFocusEntry: 'deckFocusEntry',
};

export function isKnownEntity(name) {
  return Object.prototype.hasOwnProperty.call(ENTITY_MAP, name);
}

function delegate(name) {
  const key = ENTITY_MAP[name];
  if (!key) throw Object.assign(new Error(`Unknown entity: ${name}`), { status: 404 });
  return prisma[key];
}

function scope(user, extra = {}) {
  if (user.role === 'admin') return extra;
  return { ...extra, created_by_id: user.id };
}

function parseSort(sort) {
  if (!sort) return { created_date: 'desc' };
  const desc = sort.startsWith('-');
  const field = desc ? sort.slice(1) : sort;
  return { [field]: desc ? 'desc' : 'asc' };
}

export async function listEntities(name, user, { sort, limit } = {}) {
  return delegate(name).findMany({
    where: scope(user),
    orderBy: parseSort(sort),
    take: limit ? Number(limit) : undefined,
  });
}

export async function filterEntities(name, user, { query = {}, sort, limit } = {}) {
  return delegate(name).findMany({
    where: scope(user, query),
    orderBy: parseSort(sort),
    take: limit ? Number(limit) : undefined,
  });
}

export async function getEntity(name, user, id) {
  const row = await delegate(name).findFirst({ where: scope(user, { id }) });
  if (!row) throw Object.assign(new Error('Not found'), { status: 404 });
  return row;
}

export async function createEntity(name, user, data) {
  const { id, created_by_id, created_date, updated_date, ...rest } = data || {};
  return delegate(name).create({ data: { ...rest, created_by_id: user.id } });
}

export async function updateEntity(name, user, id, data) {
  await getEntity(name, user, id); // ownership check (throws 404 if not owned/admin)
  const { id: _id, created_by_id, created_date, updated_date, ...rest } = data || {};
  return delegate(name).update({ where: { id }, data: rest });
}

export async function deleteEntity(name, user, id) {
  await getEntity(name, user, id);
  await delegate(name).delete({ where: { id } });
}

// The base44 SDK's `Entity.deleteMany(query)` takes a FILTER object (e.g.
// `{ project_id: id }`), not an array of ids — confirmed against every
// frontend call site (useWorkspace.js, Architect.jsx). Scoped by owner like
// every other entity op.
export async function deleteManyByQuery(name, user, query = {}) {
  const result = await delegate(name).deleteMany({ where: scope(user, query) });
  return result.count;
}

export async function bulkCreateEntities(name, user, items) {
  const rows = (items || []).map((item) => {
    const { id, created_by_id, created_date, updated_date, ...rest } = item || {};
    return { ...rest, created_by_id: user.id };
  });
  // createMany doesn't return rows; do individual creates so the frontend
  // gets ids back immediately (matches base44 SDK's bulkCreate contract).
  const created = [];
  for (const data of rows) {
    created.push(await delegate(name).create({ data }));
  }
  return created;
}
