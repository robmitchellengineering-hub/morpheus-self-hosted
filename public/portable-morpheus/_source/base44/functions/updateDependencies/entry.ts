import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { logUsage, createSnapshot, detectLanguage } from '../../shared/projectUtils.ts';

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { projectId } = body;
    if (!projectId) return Response.json({ error: 'projectId required' }, { status: 400 });

    const project = await base44.entities.Project.get(projectId);
    const files = await base44.entities.ProjectFile.filter({ project_id: projectId });

    await createSnapshot(base44, projectId, 'Pre-dependency-sync snapshot');

    const updates: any[] = [];
    const fileOps: any[] = [];

    // --- Node: package.json ---
    const pkgFile = files.find((f: any) => f.path === 'package.json');
    if (pkgFile) {
      try {
        const pkg = JSON.parse(pkgFile.content);
        const allDeps: Record<string, string> = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        const names = Object.keys(allDeps).slice(0, 30);

        const results = await Promise.all(
          names.map(async (name) => {
            try {
              const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`);
              if (res.ok) { const d = await res.json(); return { name, version: d.version }; }
              return { name, version: null };
            } catch { return { name, version: null }; }
          })
        );

        let changed = 0;
        for (const { name, version } of results) {
          if (!version) continue;
          const current = allDeps[name] || '';
          const currentClean = current.replace(/[\^~>=<]/g, '').trim();
          if (currentClean && currentClean !== version) {
            const newVersion = `^${version}`;
            if (pkg.dependencies?.[name] !== undefined) pkg.dependencies[name] = newVersion;
            if (pkg.devDependencies?.[name] !== undefined) pkg.devDependencies[name] = newVersion;
            updates.push({ name, from: current, to: newVersion });
            changed++;
          }
        }
        if (changed > 0) {
          fileOps.push({ path: 'package.json', action: 'update', content: JSON.stringify(pkg, null, 2) });
        }
      } catch { /* parse error — skip */ }
    }

    // --- Python: requirements.txt ---
    const reqFile = files.find((f: any) => f.path === 'requirements.txt');
    if (reqFile) {
      const lines = reqFile.content.split('\n');
      const pkgs = lines
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'))
        .map(l => (l.match(/^([a-zA-Z0-9_-]+)/) || [])[1])
        .filter(Boolean) as string[];

      const toCheck = [...new Set(pkgs)].slice(0, 30);
      const results = await Promise.all(
        toCheck.map(async (name) => {
          try {
            const res = await fetch(`https://pypi.org/pypi/${name}/json`);
            if (res.ok) { const d = await res.json(); return { name, version: d.info?.version }; }
            return { name, version: null };
          } catch { return { name, version: null }; }
        })
      );

      const versionMap: Record<string, string> = {};
      for (const { name, version } of results) {
        if (version) versionMap[name.toLowerCase()] = version;
      }

      let changed = 0;
      const newLines = lines.map(l => {
        const m = l.match(/^([a-zA-Z0-9_-]+)([=<>!~]+\s*)(.*)/);
        if (m) {
          const name = m[1];
          const latest = versionMap[name.toLowerCase()];
          if (latest) {
            changed++;
            updates.push({ name, from: l, to: `${name}==${latest}` });
            return `${name}==${latest}`;
          }
        }
        return l;
      });
      if (changed > 0) {
        fileOps.push({ path: 'requirements.txt', action: 'update', content: newLines.join('\n') });
      }
    }

    // Apply updates
    for (const op of fileOps) {
      const existing = files.find((f: any) => f.path === op.path);
      if (existing) {
        await base44.entities.ProjectFile.update(existing.id, { content: op.content, language: detectLanguage(op.path) });
      }
    }

    await logUsage(base44, 'chat_simple', projectId, project.name, { action: 'sync_deps', updated: updates.length });

    let reply: string;
    if (updates.length === 0) {
      reply = '// DEPS SYNCED — All dependencies are already at their latest versions. Morpheus is coding against current references.';
    } else {
      const lines = updates.map(u => `  ${u.name}: ${u.from || '?'} → ${u.to}`);
      reply = `[DEPS SYNCED] Updated ${updates.length} package(s) to latest versions:\n${lines.join('\n')}\n\n// References refreshed. Morpheus will use these versions going forward.`;
    }

    return Response.json({ reply, fileOperations: fileOps, updatedCount: updates.length, updates });
  } catch (error) {
    console.error('Sync deps error:', error?.message || error);
    return Response.json({ error: error?.message || 'Unknown error' }, { status: 500 });
  }
}