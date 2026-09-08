// Apply self-dev DB migrations (SELF-DEV-V2 A2).
//
// Runs any server/prisma/selfdev-*.sql in the workspace that isn't already in
// the self_dev_migrations table. Additive-only (see lib/selfDevMigrations.js);
// a migration with a risky statement is reported as needs-manual, never run.
// Each migration's statements run in one transaction (Postgres DDL is
// transactional) with the tracking-row insert, so a partial apply can't happen.
//
// Called automatically after a self-dev change lands (mergeSelfDevPr.js /
// pushSelfDevToGithub.js direct path), and available as a manual APPLY
// MIGRATIONS action + a dryRun list.
import { prisma } from '../db.js';
import { logUsage } from '../lib/projectUtils.js';
import {
  MIGRATION_RE, classifyMigration, ensureMigrationTable, appliedMigrationNames,
} from '../lib/selfDevMigrations.js';

export async function runApplySelfDevMigrations(user, { projectId = null, dryRun = false } = {}) {
  const project = projectId
    ? await prisma.project.findFirst({ where: { id: projectId, created_by_id: user.id, project_type: 'self_dev' } })
    : await prisma.project.findFirst({ where: { created_by_id: user.id, project_type: 'self_dev' } });
  if (!project) throw Object.assign(new Error('Self-dev project not found'), { status: 404 });

  const files = await prisma.projectFile.findMany({
    where: { project_id: project.id },
    select: { path: true, content: true },
  });
  const migrations = files
    .filter((f) => MIGRATION_RE.test(f.path))
    .sort((a, b) => a.path.localeCompare(b.path));

  await ensureMigrationTable(prisma);
  const done = await appliedMigrationNames(prisma);

  const results = [];
  for (const f of migrations) {
    const name = f.path.replace(/^server\/prisma\//, '');
    if (done.has(name)) { results.push({ filename: name, status: 'already-applied' }); continue; }

    const { additive, stmts, riskyStatements } = classifyMigration(f.content || '');
    if (stmts.length === 0) { results.push({ filename: name, status: 'empty' }); continue; }
    if (!additive) { results.push({ filename: name, status: 'needs-manual', riskyStatements }); continue; }
    if (dryRun) { results.push({ filename: name, status: 'pending', statementCount: stmts.length }); continue; }

    try {
      await prisma.$transaction(async (tx) => {
        for (const s of stmts) await tx.$executeRawUnsafe(s);
        await tx.$executeRawUnsafe(
          'insert into self_dev_migrations (filename, statement_count) values ($1, $2)',
          name, stmts.length,
        );
      });
      results.push({ filename: name, status: 'applied', statementCount: stmts.length });
    } catch (e) {
      results.push({ filename: name, status: 'failed', error: e.message });
    }
  }

  const applied = results.filter((r) => r.status === 'applied');
  const failed = results.filter((r) => r.status === 'failed');
  const manual = results.filter((r) => r.status === 'needs-manual');

  if (!dryRun && (applied.length || failed.length || manual.length)) {
    const lines = [];
    if (applied.length) lines.push(`Applied ${applied.length} migration(s) to the database: ${applied.map((r) => r.filename).join(', ')}.`);
    if (failed.length) lines.push(`⚠️ ${failed.length} migration(s) FAILED: ${failed.map((r) => `${r.filename} (${r.error})`).join('; ')}. Production may be on a schema the new code doesn't expect — fix the SQL and re-run, or REVERT.`);
    if (manual.length) lines.push(`${manual.length} migration(s) need manual application (not additive-only): ${manual.map((r) => r.filename).join(', ')}. Run them against Supabase yourself.`);
    await prisma.chatMessage.create({
      data: { created_by_id: user.id, project_id: project.id, role: 'morpheus', content: lines.join('\n') },
    });
    await logUsage(user.id, 'self_dev_migrate', project.id, project.name, {
      applied: applied.length, failed: failed.length, manual: manual.length,
    });
  }

  return {
    results,
    applied: applied.length,
    failed: failed.length,
    manual: manual.length,
    pending: results.filter((r) => r.status === 'pending').length,
  };
}

export default async function handler({ user, body }) {
  if (user.role !== 'admin') throw Object.assign(new Error('Self-dev is admin only'), { status: 403 });
  return runApplySelfDevMigrations(user, {
    projectId: body?.projectId || null,
    dryRun: body?.dryRun === true,
  });
}
