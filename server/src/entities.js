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
import { decodeConnections, encodeConnections } from './lib/connectionSecrets.js';
import { deckProfileSelectAttempts, deckProfileWriteAttempts, isMissingDeckProfileColumn, deckProfileWriteResult } from './lib/deckProfileColumns.js';
import { reconcileStaleWidgetBuilds } from './lib/deckWidgetBuildReconcile.js';

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
  DeckLifeFile: 'deckLifeFile',
  DeckEnergyLogEntry: 'deckEnergyLogEntry',
  DeckFocusEntry: 'deckFocusEntry',
  DeckWidgetInstance: 'deckWidgetInstance',
  DeckBusinessProfile: 'deckBusinessProfile',
  DeckWidgetBuild: 'deckWidgetBuild',
  DeckPlayCredit: 'deckPlayCredit',
  DeckPlayScore: 'deckPlayScore',
};

export function isKnownEntity(name) {
  return Object.prototype.hasOwnProperty.call(ENTITY_MAP, name);
}

function delegate(name) {
  const key = ENTITY_MAP[name];
  if (!key) throw Object.assign(new Error(`Unknown entity: ${name}`), { status: 404 });
  return prisma[key];
}

// 2026-09-17: Command Deck entities are strictly private per-account data
// (life/business data for whichever account owns it, not an
// admin-manageable platform resource like MaintenanceTask) — confirmed live
// that the admin bypass below was merging every account's Deck rows into
// Rob's own /deck view the moment a second real account had any Deck data,
// since he's the platform's only admin. Deck* entities always scope to the
// caller, admin or not.
function scope(user, name, extra = {}) {
  if (user.role === 'admin' && !name.startsWith('Deck')) return extra;
  return { ...extra, created_by_id: user.id };
}

function parseSort(sort) {
  if (!sort) return { created_date: 'desc' };
  const desc = sort.startsWith('-');
  const field = desc ? sort.slice(1) : sort;
  return { [field]: desc ? 'desc' : 'asc' };
}

// DeckBusinessProfile-only, and the H11 rule this change is subject to (see
// lib/deckProfileColumns.js): the fee columns ship in schema.prisma while the hand-run SQL lands
// later, so every read/write of this model names its columns and steps back to the
// pre-migration shape the moment Prisma says a column is missing. The alternative — reading with
// no `select`, which is what this file used to do — is P2022 on every Deck load until the SQL
// runs, i.e. the whole Deck down over one unapplied setting.
// UserSettings.connections is ENCRYPTED AT REST (2026-09-28) — the column, the schema comment and
// the Connections UI all say so, and until this change only the last two were true.
//
// The wire format deliberately does NOT change: the client still receives this field as a JSON
// STRING and still parses it (src/pages/Settings.jsx does `JSON.parse(rows[0].connections)`), so
// encrypting at rest without decrypting on the way out would silently blank every connection the
// user had saved — they would look "not connected" for a token that was stored perfectly. All of it
// therefore happens here, in the one layer both the client and every server caller go through.
function withDecryptedConnections(row) {
  if (!row || typeof row !== 'object' || row.connections == null) return row;
  return { ...row, connections: JSON.stringify(decodeConnections(row.connections)) };
}

function writeUserSettingsSecrets(data) {
  if (!data || typeof data !== 'object' || !('connections' in data) || data.connections == null) return data;
  return { ...data, connections: encodeConnections(data.connections) };
}

// Both of these step down NEWEST COLUMNS FIRST (operating_regions, then the fee tiers, then the
// pre-2026-09-28 shape), so an environment missing only the newest migration keeps the settings it
// does have. One shared attempt list, so the read here and the read in lib/deckBusinessProfile.js
// cannot step down differently.
async function readDeckProfile(run) {
  const attempts = deckProfileSelectAttempts();
  for (let i = 0; i < attempts.length; i += 1) {
    try {
      return await run(attempts[i]);
    } catch (err) {
      if (!isMissingDeckProfileColumn(err) || i + 1 >= attempts.length) throw err;
    }
  }
  return null;
}

async function writeDeckProfile(run, data) {
  const attempts = deckProfileWriteAttempts(data);
  for (let i = 0; i < attempts.length; i += 1) {
    try {
      const row = await run(attempts[i].data);
      // A retry stores everything BUT the fields that could not be written, so it must not come
      // back looking like a plain success: deckProfileWriteResult adds fee_fields_dropped /
      // region_fields_dropped when (and only when) a fallback was used for a write that carried
      // them. Settings says so in words.
      return deckProfileWriteResult(row, data, { droppedFields: attempts[i].droppedFields });
    } catch (err) {
      if (!isMissingDeckProfileColumn(err) || i + 1 >= attempts.length) throw err;
    }
  }
  return null;
}

export async function listEntities(name, user, { sort, limit } = {}) {
  const query = {
    where: scope(user, name),
    orderBy: parseSort(sort),
    take: limit ? Number(limit) : undefined,
  };
  if (name === 'DeckBusinessProfile') {
    return readDeckProfile((select) => delegate(name).findMany({ ...query, select }));
  }
  // Widget-build progress is the one entity whose row is written by a ~15-minute process that the
  // DEPLOY IT TRIGGERS replaces, so it can be left non-terminal with nothing alive to finish it.
  // Settings polls this list while a build's status is not done/failed, which means a dead row shows
  // as a progress bar frozen forever — two 2026-09-17 builds did exactly that for eleven days. The
  // read the poll already makes is the one place guaranteed to run after such a death, so a row that
  // has stopped reporting is resolved here. Cheap: one indexed query, and only non-terminal rows.
  if (name === 'DeckWidgetBuild') await reconcileStaleWidgetBuilds(user.id);
  const rows = await delegate(name).findMany(query);
  return name === 'UserSettings' && Array.isArray(rows) ? rows.map(withDecryptedConnections) : rows;
}

export async function filterEntities(name, user, { query = {}, sort, limit } = {}) {
  const args = {
    where: scope(user, name, query),
    orderBy: parseSort(sort),
    take: limit ? Number(limit) : undefined,
  };
  if (name === 'DeckBusinessProfile') {
    return readDeckProfile((select) => delegate(name).findMany({ ...args, select }));
  }
  const rows = await delegate(name).findMany(args);
  return name === 'UserSettings' && Array.isArray(rows) ? rows.map(withDecryptedConnections) : rows;
}

export async function getEntity(name, user, id) {
  const run = (extra) => delegate(name).findFirst({ where: scope(user, name, { id }), ...extra });
  const row = name === 'DeckBusinessProfile'
    ? await readDeckProfile((select) => run({ select }))
    : await run({});
  if (!row) throw Object.assign(new Error('Not found'), { status: 404 });
  return name === 'UserSettings' ? withDecryptedConnections(row) : row;
}

// `project_type` is documented as frontend|backend, and those two are set by the
// client. `self_dev` is not a project type a client may choose: it is the
// singleton mirror of this repo, created server-side by importSelfDevRepo, and
// every self-dev function then resolves it by owner.
//
// Allowing a client to write it was a real hole rather than a tidiness issue.
// `resolveSelfDevActor()` looked a self_dev project up without scoping to an
// owner, so a user-created row could win the race and break widget builds for
// everyone; and `updateEntity` could rename the real workspace out of the type,
// making it unreachable. Both are now defended in depth — the lookup is scoped
// and ordered too — but refusing the write here is what closes the vector, so a
// caller that tries is told rather than silently ignored.
const RESERVED_PROJECT_TYPES = new Set(['self_dev']);

function assertNotReserved(name, data) {
  if (name !== 'Project' || !data || !RESERVED_PROJECT_TYPES.has(data.project_type)) return;
  throw Object.assign(
    new Error(`project_type "${data.project_type}" is reserved for Morpheus's own workspace and cannot be set through the API.`),
    { status: 403, code: 'RESERVED_PROJECT_TYPE' },
  );
}

export async function createEntity(name, user, data) {
  const { id, created_by_id, created_date, updated_date, ...rest } = data || {};
  assertNotReserved(name, rest);
  const write = (fields) => delegate(name).create({ data: { ...fields, created_by_id: user.id } });
  if (name === 'DeckBusinessProfile') return writeDeckProfile(write, rest);
  if (name === 'UserSettings') return writeUserSettingsSecrets(write(rest));
  return write(rest);
}

export async function updateEntity(name, user, id, data) {
  const existing = await getEntity(name, user, id); // ownership check (throws 404 if not owned/admin)
  const { id: _id, created_by_id, created_date, updated_date, ...rest } = data || {};
  // Setting the reserved type is refused, and so is taking the workspace OUT of
  // it — the second is the one that would orphan the singleton.
  assertNotReserved(name, rest);
  if (name === 'Project' && existing.project_type === 'self_dev'
    && 'project_type' in rest && rest.project_type !== 'self_dev') {
    throw Object.assign(
      new Error("The self-dev workspace's project_type cannot be changed through the API."),
      { status: 403, code: 'RESERVED_PROJECT_TYPE' },
    );
  }
  const write = (fields) => delegate(name).update({ where: { id }, data: fields });
  if (name === 'DeckBusinessProfile') return writeDeckProfile(write, rest);
  if (name === 'UserSettings') {
    // The row that comes back is echoed to the client, so it must be decrypted like a read —
    // otherwise the save itself would appear to have wiped the connections.
    return withDecryptedConnections(await writeUserSettingsSecrets(write(rest)));
  }
  return write(rest);
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
  const result = await delegate(name).deleteMany({ where: scope(user, name, query) });
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
