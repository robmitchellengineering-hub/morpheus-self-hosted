# Data model, generic entity CRUD and migrations

Scope: `server/prisma/schema.prisma` (1319 lines, 52 models, 52 `@@map` tables),
`server/src/db.js` (17 lines), `server/src/entities.js` (151 lines),
`server/src/routes/entities.routes.js` (83 lines) and the 39 `*.sql` files in `server/prisma/`.
All claims are cited to files the audit read.

## Source of truth

- `schema.prisma` is authoritative. Datasource is `provider = "postgresql"`,
  `url = env("DATABASE_URL")`; generator is `prisma-client-js` with no explicit output path.
- `server/src/db.js` is a 17-line `PrismaClient` singleton cached on `globalThis` in
  non-production — deliberate, to survive `node --watch` restarts without exhausting the pool.
- Field names are deliberately **snake_case**, mirroring the original Base44 entity schemas
  (schema.prisma:1-7), so the 34 ported function handlers and the React frontend need no
  translation layer. `@@map` keeps table names in the same convention.

## Models grouped by concern

Line numbers are `schema.prisma` positions of each `model`.

**Identity, settings and scoped credentials** — `User` (24), `UserSettings` (110),
`WidgetToken` (873), `DeviceAuthRequest` (907), `DeviceToken` (928).
`WidgetToken`/`DeviceToken` store only a SHA-256 of the secret; the full token is shown once.

**Projects and build artefacts** — `Project` (221), `ProjectFile` (293), `ChatMessage` (320),
`FileSnapshot` (335). This is the core four; almost everything else hangs off `Project`.

**Metering, billing and catalogue** — `UsageRecord` (353), `UsageEvent` (383),
`ModelCatalogEntry` (417), `CreditTransaction` (443), `Purchase` (570), `Donation` (601),
`CostSnapshot` (797).

**Platform and admin** — `PlatformSetting` (479), `AdminAuditLog` (498),
`MaintenanceTask` (516), `Feedback` (619).

**Marketplace** — `Template` (532).

**Integrations** — `GithubConnection` (145), `GoogleDriveConnection` (168),
`BackendConfig` (633), `PluginConnection` (848).

**Self-dev (Morpheus editing its own repo)** — `RebuildDoc` (654), `SelfDevManual` (687),
`SelfDevFeature` (715), `SelfDevDecision` (748), `UpdatesPlan` (773).

**Media library** — `ProjectAsset` (819).

**Command Deck (21 models)** — `DeckGoogleConnection` (195) plus the `Deck*` block at
962-1305: `DeckJarvisMessage`, `DeckJarvisMemory`, `DeckDumpItem`, `DeckPerson`, `DeckTask`,
`DeckConsignmentItem`, `DeckRepairJob`, `DeckRepairFile`, `DeckMurbahOpportunity`,
`DeckInboxItem`, `DeckGmailSeenMessage`, `DeckStrategyNote`, `DeckKnowledgeNote`,
`DeckLifeStream`, `DeckLifeStreamNote`, `DeckEnergyLogEntry`, `DeckFocusEntry`,
`DeckWidgetInstance`, `DeckWidgetBuild`, `DeckBusinessProfile`.

## Relationships and cascades

- 61 `onDelete` declarations. The dominant pattern is every owner column cascading from
  `User`: `@relation(fields: [created_by_id], references: [id], onDelete: Cascade)` — e.g.
  UserSettings:113, GithubConnection:148, GoogleDriveConnection:171, DeckGoogleConnection:198,
  Project:224, ProjectFile:296, ChatMessage:323, FileSnapshot:338, UsageRecord:356,
  ProjectAsset:822, PluginConnection:851, WidgetToken:876, DeviceToken:931.
- Project children cascade from `Project`: ProjectFile:298, ChatMessage:325, FileSnapshot:340,
  BackendConfig:638, SelfDevFeature:720, SelfDevDecision:753, ProjectAsset:824,
  PluginConnection:853, WidgetToken:878.
- **`SetNull` instead of cascade** where history should outlive its parent:
  UsageRecord→Project:361, Template→Project:537, Purchase→Template:580,
  PlatformSetting→updated_by:483, AdminAuditLog→admin:501.
- Intra-Deck cascades exist: DeckRepairFile→DeckRepairJob:1084, DeckLifeStreamNote→DeckLifeStream:1205.
- Referential integrity is enforced at the Prisma level and **duplicated by hand** in the SQL:
  `add-deck-entities.sql` declares `REFERENCES users(id) ON DELETE CASCADE` explicitly rather
  than relying on `@@map` alone.

### Soft (non-FK) links — exceptions that bypass cascades

- `UsageEvent.project_id` is explicitly commented "best-effort correlation only, not a hard FK"
  (schema.prisma:400-401).
- `DeckTask.owner_person_id`, `DeckMurbahOpportunity.calendar_event_id`,
  `DeviceAuthRequest.approved_by_id` and `DeviceAuthRequest.issued_token_id` are plain nullable
  strings with no relation. Deleting a `DeckPerson` does **not** clean up `DeckTask.owner_person_id`.
- `DeckInboxItem.external_id` has no unique constraint even though it is the Gmail dedup key;
  only `DeckGmailSeenMessage` enforces `@@unique([created_by_id, external_id])`.

### Row-metadata exceptions

The schema header (schema.prisma:9-11) claims "Every entity carries id / created_by_id /
created_date / updated_date", matching Base44 implicit row metadata. It holds only for the
owner-scoped majority. Documented exceptions:

- `PlatformSetting` uses `key @id` — no `id`, `created_date` or `created_by_id`.
- `AdminAuditLog` uses `admin_id` — no `created_by_id`, no `updated_date`.
- `ModelCatalogEntry`, `Donation`, `Feedback`, `DeviceAuthRequest` have no `created_by_id` at all.
- Many append-only tables have `created_date` but no `updated_date`: `Purchase`,
  `CreditTransaction`, `UsageEvent`, `WidgetToken`, `DeviceToken`, `ProjectAsset`,
  `DeckRepairFile`, `DeckLifeStreamNote`, `DeckEnergyLogEntry`, `DeckGmailSeenMessage`.

## Generic entity CRUD (`entities.js`)

Wire path: `/api/entities/:name` → `routes/entities.routes.js` → `entities.js` → `prisma[ENTITY_MAP[name]]`.
Routes exposed: `GET/POST /:name`, `POST /:name/filter`, `GET/PUT/DELETE /:name/:id`,
`POST /:name/bulk-create`, `POST /:name/bulk-delete`.

- `ENTITY_MAP` (entities.js:20-65) covers **33 of 52** models. `isKnownEntity` returns 404 for
  anything else (entities.routes.js:11-14).
- `createEntity` strips `id`/`created_by_id`/`created_date`/`updated_date` from the body and
  forces `created_by_id = user.id` (entities.js:114-117).
- `updateEntity` re-runs `getEntity` as an ownership check, then strips the same metadata
  fields (entities.js:119-123).
- `scope(user, name, extra)` (entities.js:80-83) is the RLS replacement. It reproduces Base44's
  `{ "created_by_id": "{{user.id}}" }` filter, and its admin branch reproduces RLS's
  `user_condition: role=admin` bypass: if `user.role === 'admin'` **and** the entity name does
  not start with `Deck`, it returns `extra` with **no** `created_by_id` filter. Otherwise it
  returns `{ ...extra, created_by_id: user.id }`.
- The 19 models with no generic route: `User`, `GoogleDriveConnection`, `DeckGoogleConnection`,
  `UsageEvent`, `ModelCatalogEntry`, `CreditTransaction`, `PlatformSetting`, `AdminAuditLog`,
  `Donation`, `Feedback`, `SelfDevFeature`, `SelfDevDecision`, `ProjectAsset`,
  `PluginConnection`, `WidgetToken`, `DeviceAuthRequest`, `DeviceToken`, `DeckJarvisMemory`,
  `DeckGmailSeenMessage`. For `PlatformSetting`/`AdminAuditLog`/`ModelCatalogEntry` this is
  intentional and documented (entities.js:35-39, schema.prisma:489-497) — they are served by
  bespoke audited `admin.routes.js` handlers. `SelfDevFeature`/`SelfDevDecision` are served by
  dedicated functions. The entities.js header comment claiming "a single generic handler works
  for all 11 entities" (entities.js:6-8) is **stale**: the map holds 33 and the schema 52.

## The Deck exception (must not be broken)

Deck is private per-account and must never reuse a Morpheus-level entity:
`DeckGoogleConnection` is separate from `GoogleDriveConnection` and login OAuth;
`DeckJarvisMessage`/`DeckJarvisMemory` are separate from `ChatMessage` (which is hard-coupled
to a required Project FK). This "own data, own connections, own accounts" rule is stated at
schema.prisma:188-194 and :957-961 and in `.dsh/skills/morpheus-deck/SKILL.md:23-52`.
`Deck*` names are the **only** entities exempt from the admin owner-scope bypass, enforced by
the string prefix `name.startsWith('Deck')` in entities.js:81 — added 2026-09-17 after admins
merged every account's Deck rows into one `/deck` view.

## Migration workflow

There is **no versioned migration history**: no `server/prisma/migrations/` directory and no
`migration_lock.toml` anywhere in the repo. Every change is hand-run or self-dev-run SQL.

### Convention A — `selfdev-<slug>.sql` (auto-applied, auto-gated)

Shipped by a schema change and picked up by the self-dev pipeline.

- Filename must match `MIGRATION_RE` = `/^server\/prisma\/selfdev-[a-z0-9][a-z0-9-]*\.sql$/i`
  (`server/src/lib/selfDevMigrations.js:22`). The sole instance in the repo is
  `selfdev-add-synced-commit.sql`.
- `classifyMigration` checks statements against the `ADDITIVE` allowlist
  (selfDevMigrations.js:24-34). Only `CREATE TABLE`, `CREATE [UNIQUE] INDEX`,
  `ALTER TABLE ... ADD COLUMN`, `ADD CONSTRAINT`, `CREATE TYPE`, `ALTER TYPE ... ADD VALUE`,
  `CREATE EXTENSION` and `COMMENT ON` are auto-applied; anything else is reported
  `needs-manual` and left for a human (applySelfDevMigrations.js:40-42).
- `applySelfDevMigrations` is an admin-only function handler (throws 403 for non-admin,
  applySelfDevMigrations.js:86) and is in `ADMIN_FUNCTIONS` (functions.routes.js:50), so widget
  and device tokens can never reach it even when the owner is an admin.
- Flow: read all `ProjectFile` rows of the admin's `project_type='self_dev'` project → filter by
  `MIGRATION_RE` → skip names already present in `self_dev_migrations` → classify → run each
  file's split statements **plus** the tracking-row INSERT in one `prisma.$transaction`
  (applySelfDevMigrations.js:6-8, :46-52; Postgres DDL is transactional) → write a `ChatMessage`
  summary and `logUsage('self_dev_migrate')`.
- `pushSelfDevToGithub.js` runs a precheck that blocks a push when a schema change has no
  migration (reason `schema-no-migration`), then runs `runApplySelfDevMigrations` after a
  successful direct push.

### Convention B — `add-*.sql` (hand-run, untracked)

Everything else: `add-deck-*.sql` (18 files), `add-project-documents-table.sql`, and the
bootstrap DDL. The operator pastes the file into the Supabase SQL editor ("Run without RLS";
Prisma direct connection, not PostgREST) or runs `psql "$DATABASE_URL" -f <file>`. Deck files
are run by the agent, not left for the human, per `.dsh/skills/morpheus-deck/SKILL.md`. The
`ADDITIVE` allowlist does **not** govern these — nothing classifies them at all.

### Bootstrap and CLI

- `server/prisma/manual-supabase-init.sql` is the hand-written fresh-DB DDL.
- `server/package.json` defines `prisma:generate`, `prisma:migrate` (`prisma migrate deploy`),
  `prisma:migrate:dev` (`prisma migrate dev`), `prisma:studio`. With no migrations directory
  those scripts have nothing to deploy; manual-supabase-init.sql:6-15 explains the schema was
  hand-written because the environment had no npm registry access, and instructs baselining
  with `prisma migrate resolve --applied <name>` before ever running `prisma migrate dev`.

## Load-bearing invariants

1. **schema.prisma is the only model source.** SQL files must be kept in step by hand.
2. **`scope()` is the RLS replacement** and its admin bypass is on by default for every
   non-`Deck*` entity in `ENTITY_MAP`.
3. **Deck has its own tables, connections and accounts** and is exempt from the admin bypass.
4. **Self-dev migrations are additive-only and idempotent by filename.** The check is
   `done.has(name)` on `self_dev_migrations.filename` (applySelfDevMigrations.js:38) — there is
   no content hash, so editing an already-applied file is a silent no-op.
5. **A migration file in the repo does not mean it was applied.** Verification is a manual
   `information_schema` read or a live console check (`morpheus-stack/SKILL.md:81`,
   `morpheus-deck/SKILL.md:82-86`).

## Risks (reported by the audit)

- **No versioned migration history at all.** Ordering, atomicity and "was it applied?" are on
  the operator. `prisma:migrate` / `prisma:migrate:dev` may be dead code.
- **`manual-supabase-init.sql` is stale by table count**: 26 `CREATE TABLE` statements (one of
  which, `self_dev_migrations`, is a runtime tracking table, not a model) covering only 25 of
  the 52 mapped models. A DB bootstrapped from it alone is missing `google_drive_connections`,
  `deck_google_connections`, `project_assets`, `plugin_connections`, `widget_tokens`,
  `device_auth_requests`, `device_tokens` and all 20 `deck_*` tables.
- **`add-project-documents-table.sql` is an orphan**: it creates `project_documents` and cites a
  `ProjectDocument` model that does not exist in `schema.prisma`, has no `ENTITY_MAP` entry and
  is referenced nowhere else. The repo cannot tell you whether the model was removed or the
  table was never adopted, and nothing verifies it in production.
- **Two incompatible naming conventions coexist.** A Deck schema change shipped as
  `add-deck-x.sql` is neither blocked by the H8 precheck nor applied by
  `applySelfDevMigrations`; it relies entirely on the operator. `morpheus-deck/SKILL.md` records
  the concrete failure: four migrations left typed-and-waiting and production broken by
  `deck_people.email does not exist` until a live console error surfaced it.
- **The H8 gate has a hole on the direct-to-main path.** `pushSelfDevToGithub.js:121-128` blocks
  only when `schemaChanged && !hasMigration && !directToMain`. The ADMIN policy in
  `enginePolicy.js` sets `allowDirectToMain: true`, so an admin direct push can ship a schema
  change with no migration — exactly the H8 failure state.
- **Auto-apply failure is silent to the DB.** `applySelfDevMigrations` records status `failed`
  per file and writes a `ChatMessage` and usage row (applySelfDevMigrations.js:54-73), but it
  runs **after** the push already succeeded; `pushSelfDevToGithub.js:215` logs with
  `console.error` and comments "migration apply failed (push succeeded)". Code can be live
  against an un-migrated schema.
- **Admin scope bypass applies to every non-Deck entity in `ENTITY_MAP`.** An admin's
  list/filter/get/update/delete reaches every account's rows for `Project`, `ProjectFile`,
  `ChatMessage`, `FileSnapshot`, `UsageRecord`, `Template`, `Purchase`, `UserSettings`,
  `BackendConfig`, `RebuildDoc`, `SelfDevManual`, `UpdatesPlan`, `CostSnapshot`,
  `GithubConnection`, `MaintenanceTask`. This was patched only for `Deck*` after the `/deck`
  merge incident. A new per-user model added to `ENTITY_MAP` without a `Deck` prefix inherits
  the cross-account exposure for admins.
- **`Project.project_type` comment drift**: declared `// frontend | backend` at
  schema.prisma:230, but `'self_dev'` is a real third value relied on across the codebase —
  `importSelfDevRepo.js:82` creates the singleton, and `revertSelfDevPush`, `smokeCheckSelfDev`,
  `pushSelfDevToGithub`, `buildDeckWidget`, `generateSelfDevManual` all query
  `project_type: 'self_dev'`. Trusting the comment misses the self-dev project.
- **Soft links bypass cascades** (see above), so deleting a `DeckPerson` orphans
  `DeckTask.owner_person_id`, and `DeckInboxItem.external_id` is an unconstrained dedup key.

## Open questions

- Which of the 39 `*.sql` files have actually been applied to any real database. The repo has
  no applied-state record for the `add-*.sql` family (only `selfdev-*.sql` is tracked, in
  `self_dev_migrations`), and no `DATABASE_URL` was available to query `information_schema`.
- Whether `project_documents` exists in production, and whether `ProjectDocument` was
  deliberately deleted or never added.
- Whether the `prisma:migrate` / `prisma:migrate:dev` scripts have ever been used.
- Column-level drift between `manual-supabase-init.sql` and `schema.prisma` (table-level drift
  is known: 26 statements vs 52 models). The audit read the headers of every SQL file and the
  full body of `add-deck-entities.sql`, `add-project-documents-table.sql` and
  `selfdev-add-synced-commit.sql`, but not all ~15 KB of `manual-supabase-init.sql` line by line.
- Production row counts, and whether any account besides Rob's has real Deck data — not
  queryable from the repo.
- `base44/` (original Base44 entity/function definitions, referenced by schema.prisma:3-4 and
  KNOWN-HAZARDS H7) and `hosted-broker/` were not audited for additional entity definitions
  that might be mirrored into this schema.
- The 18 `add-deck-*.sql` files were checked by header only; they are additive in stated intent
  but no statement was classified against the `ADDITIVE` allowlist (which does not govern them).
