import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { logUsage, createSnapshot, detectLanguage } from '../../shared/projectUtils.ts';

// ---------------------------------------------------------------------------
// Dependency updater registry
// ---------------------------------------------------------------------------
// Each updater knows how to parse ONE manifest format, look up the latest
// versions of its packages on the relevant registry, and rewrite the file.
// To support a new ecosystem (a new compile target that introduces a new
// manifest), add an entry to REGISTRY below — nothing else needs to change.
//
// `lookup(ecosystem, name)` resolves the latest stable version string for a
// single package on its registry, with an in-memory cache so a package that
// appears in several sections is only fetched once.

type Update = { name: string; from: string; to: string; ecosystem: string; breaking?: boolean };
type UpdateResult = { updates: Update[]; content: string } | null;
type Lookup = (ecosystem: string, name: string) => Promise<string | null>;
type Updater = {
  ecosystem: string;
  match: (path: string) => boolean;
  update: (content: string, lookup: Lookup) => Promise<UpdateResult>;
};

// Per-ecosystem cap so a pathological project can't fan out hundreds of
// registry calls and time the function out.
const MAX_PER_ECOSYSTEM = 200;

function majorOf(v: string): number | null {
  const m = String(v).match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}
function isBreaking(from: string, to: string): boolean {
  const f = majorOf(from), t = majorOf(to);
  return f !== null && t !== null && f !== t;
}
// Strip leading range/operator chars to get a comparable bare version.
function bare(v: string): string {
  return String(v || '').replace(/[\^~>=<]/g, '').trim().split(/[^0-9.]/)[0];
}

// --- registry lookups --------------------------------------------------------
const lookupCache = new Map<string, string | null>();
async function lookup(ecosystem: string, name: string): Promise<string | null> {
  const key = `${ecosystem}:${name}`;
  if (lookupCache.has(key)) return lookupCache.get(key) ?? null;
  let v: string | null = null;
  try {
    if (ecosystem === 'npm') {
      const r = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`);
      if (r.ok) v = (await r.json()).version;
    } else if (ecosystem === 'pypi') {
      const r = await fetch(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
      if (r.ok) v = (await r.json()).info?.version;
    } else if (ecosystem === 'maven') {
      // name is "group:artifact". Try Maven Central first, then Google's Android
      // Maven (androidx.* and most Android libs live there, not on Central).
      const [g, a] = name.split(':');
      if (g && a) {
        const path = `${g.replace(/\./g, '/')}/${a}/maven-metadata.xml`;
        const parse = (xml: string) => {
          const rel = xml.match(/<release>([^<]+)<\/release>/);
          const lat = xml.match(/<latest>([^<]+)<\/latest>/);
          return rel?.[1] || lat?.[1] || null;
        };
        for (const base of ['https://repo1.maven.org/maven2', 'https://dl.google.com/dl/android/maven2']) {
          try {
            const r = await fetch(`${base}/${path}`);
            if (r.ok) { v = parse(await r.text()); if (v) break; }
          } catch { /* try next repo */ }
        }
      }
    } else if (ecosystem === 'cargo') {
      const r = await fetch(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`);
      if (r.ok) {
        const d = await r.json();
        v = d.data?.max_stable_version || d.data?.max_version || null;
      }
    } else if (ecosystem === 'go') {
      // Go module proxy encodes uppercase letters as `!` + lowercase.
      const enc = name.replace(/[A-Z]/g, c => '!' + c.toLowerCase());
      const r = await fetch(`https://proxy.golang.org/${enc}/@latest`);
      if (r.ok) v = (await r.json()).Version;
    } else if (ecosystem === 'gem') {
      const r = await fetch(`https://rubygems.org/api/v1/gems/${encodeURIComponent(name)}.json`);
      if (r.ok) v = (await r.json()).version;
    } else if (ecosystem === 'composer') {
      const r = await fetch(`https://repo.packagist.org/p2/${encodeURIComponent(name)}.json`);
      if (r.ok) {
        const d = await r.json();
        const list = d.packages?.[name];
        if (Array.isArray(list) && list.length) v = list[0].version;
      }
    } else if (ecosystem === 'platformio') {
      const r = await fetch(`https://registry.platformio.org/api/libraries/${encodeURIComponent(name)}`);
      if (r.ok) v = (await r.json()).version;
    }
  } catch { /* network/parse — treat as unknown */ }
  lookupCache.set(key, v);
  return v;
}

// Helper: update a single PEP-508-ish spec string ("requests>=2.0", "flask[async]",
// bare "requests"). Returns the new spec + an Update record, or null.
async function updatePipSpec(spec: string, lookup: Lookup): Promise<{ spec: string; update?: Update } | null> {
  const m = spec.match(/^([a-zA-Z0-9_.-]+)(\[[^\]]*\])?\s*(==|>=|<=|~=|!=|>|<)?\s*([^;#\s]*)/);
  if (!m) return null;
  const name = m[1], extra = m[2] || '', op = m[3] || '';
  if (op === '!=') return null; // exclusions aren't "latest"
  const latest = await lookup('pypi', name);
  if (!latest) return null;
  const cur = m[4] || '';
  if (cur && bare(cur) === bare(latest)) return null;
  const newSpec = `${name}${extra}==${latest}`;
  return { spec: newSpec, update: { name, from: spec, to: newSpec, ecosystem: 'pypi', breaking: isBreaking(cur || latest, latest) } };
}

// --- updaters ----------------------------------------------------------------
const REGISTRY: Updater[] = [
  // Node — package.json (deps, dev, peer, optional)
  {
    ecosystem: 'npm',
    match: p => p === 'package.json' || p.endsWith('/package.json'),
    update: async (content, lk) => {
      let pkg: any; try { pkg = JSON.parse(content); } catch { return null; }
      const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
      const updates: Update[] = [];
      for (const sec of sections) {
        const deps = pkg[sec];
        if (!deps || typeof deps !== 'object') continue;
        const names = Object.keys(deps).slice(0, MAX_PER_ECOSYSTEM);
        const res = await Promise.all(names.map(async n => ({ n, v: await lk('npm', n) })));
        for (const { n, v } of res) {
          if (!v) continue;
          const cur = String(deps[n] || '');
          if (!cur || /:\/\//.test(cur) || /^(workspace|file|npm|link|git):/.test(cur) || cur === '*' || cur === 'latest') continue;
          if (bare(cur) !== bare(v)) {
            const nv = `^${v}`;
            deps[n] = nv;
            updates.push({ name: n, from: cur, to: nv, ecosystem: 'npm', breaking: isBreaking(cur, v) });
          }
        }
      }
      if (!updates.length) return null;
      return { updates, content: JSON.stringify(pkg, null, 2) };
    },
  },
  // Python — requirements.txt
  {
    ecosystem: 'pypi',
    match: p => p === 'requirements.txt' || p.endsWith('/requirements.txt'),
    update: async (content, lk) => {
      const lines = content.split('\n');
      const tasks: Promise<{ i: number; spec: string; res: { spec: string; update?: Update } | null }>[] = [];
      lines.forEach((l, i) => {
        const t = l.trim();
        if (!t || t.startsWith('#') || t.startsWith('-') || /^(git|http|https|hg|svn|bzr)\+?:/i.test(t)) return;
        const m = l.match(/^([a-zA-Z0-9_.-]+)/);
        if (!m) return;
        tasks.push((async () => ({ i, spec: l, res: await updatePipSpec(l, lk) }))());
      });
      const results = await Promise.all(tasks);
      const updates: Update[] = [];
      const out = [...lines];
      for (const r of results) {
        if (r.res?.update && r.res.spec !== r.res.res!.spec) {
          out[r.i] = r.res.res!.spec;
          updates.push(r.res.res!.update!);
        }
      }
      if (!updates.length) return null;
      return { updates, content: out.join('\n') };
    },
  },
  // Python — pyproject.toml (PEP-621 dependency arrays). Scoped to dependency
  // arrays only so non-dependency fields (project name, version, …) are never
  // touched. Bracket-safe: arrays close at a `]` at end-of-line, so extras like
  // "flask[async]" don't prematurely end the body. Poetry table form is not
  // handled (use requirements.txt there).
  {
    ecosystem: 'pypi',
    match: p => p === 'pyproject.toml' || p.endsWith('/pyproject.toml'),
    update: async (content, lk) => {
      const specs = new Set<string>();
      const collectFromBody = (body: string) => {
        const re = /"([^"]+)"/g;
        let mm: RegExpExecArray | null;
        while ((mm = re.exec(body))) specs.add(mm[1]);
      };
      // Main `dependencies = [ ... ]` array (also catches dev-dependencies).
      const depRe = /\bdependencies\s*=\s*\[([\s\S]*?)\]\s*$/gm;
      let m: RegExpExecArray | null;
      while ((m = depRe.exec(content))) collectFromBody(m[1]);
      // `[project.optional-dependencies]` section: each `group = [ ... ]` array.
      const optRe = /\[project\.optional-dependencies\]([\s\S]*?)(?=\n\[|$)/g;
      while ((m = optRe.exec(content))) {
        const arrRe = /^\s*[\w.-]+\s*=\s*\[([\s\S]*?)\]\s*$/gm;
        let am: RegExpExecArray | null;
        while ((am = arrRe.exec(m[1]))) collectFromBody(am[1]);
      }
      if (!specs.size) return null;
      const res = await Promise.all([...specs].slice(0, MAX_PER_ECOSYSTEM).map(async s => ({ s, r: await updatePipSpec(s, lk) })));
      const map = new Map<string, string>();
      const updates: Update[] = [];
      for (const { s, r } of res) {
        if (r && r.spec !== s) { map.set(s, r.spec); if (r.update) updates.push(r.update); }
      }
      if (!map.size) return null;
      const transformBody = (body: string) =>
        body.replace(/"([^"]+)"/g, (_q, spec: string) => `"${map.get(spec) || spec}"`);
      let out = content.replace(depRe, (full, body: string) => full.replace(body, transformBody(body)));
      out = out.replace(optRe, (full, section: string) =>
        full.replace(section, section.replace(/^\s*[\w.-]+\s*=\s*\[([\s\S]*?)\]\s*$/gm,
          (arrFull, body: string) => arrFull.replace(body, transformBody(body)))));
      if (!updates.length) return null;
      return { updates, content: out };
    },
  },
  // Java/Kotlin — Maven pom.xml
  {
    ecosystem: 'maven',
    match: p => p === 'pom.xml' || p.endsWith('/pom.xml'),
    update: async (content, lk) => {
      const depRe = /<dependency>([\s\S]*?)<\/dependency>/g;
      const deps: { g: string; a: string; v: string }[] = [];
      let m: RegExpExecArray | null;
      while ((m = depRe.exec(content))) {
        const g = m[1].match(/<groupId>([^<]+)<\/groupId>/)?.[1];
        const a = m[1].match(/<artifactId>([^<]+)<\/artifactId>/)?.[1];
        const v = m[1].match(/<version>([^<]+)<\/version>/)?.[1];
        if (g && a && v && !/\$\{/.test(v)) deps.push({ g, a, v });
      }
      if (!deps.length) return null;
      const res = await Promise.all(deps.slice(0, MAX_PER_ECOSYSTEM).map(async d => ({ d, v: await lk('maven', `${d.g}:${d.a}`) })));
      let out = content;
      const updates: Update[] = [];
      for (const { d, v } of res) {
        if (!v || bare(d.v) === bare(v)) continue;
        const re = new RegExp(`(<dependency>[\\s\\S]*?<groupId>${d.g}</groupId>[\\s\\S]*?<artifactId>${d.a}</artifactId>[\\s\\S]*?<version>)${d.v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(<\\/version>)`);
        out = out.replace(re, `$1${v}$2`);
        updates.push({ name: `${d.g}:${d.a}`, from: d.v, to: v, ecosystem: 'maven', breaking: isBreaking(d.v, v) });
      }
      if (!updates.length) return null;
      return { updates, content: out };
    },
  },
  // Rust — Cargo.toml
  {
    ecosystem: 'cargo',
    match: p => p === 'Cargo.toml' || p.endsWith('/Cargo.toml'),
    update: async (content, lk) => {
      const lines = content.split('\n');
      const tasks: { i: number; name: string }[] = [];
      let inDepSection = false;
      lines.forEach((l, i) => {
        const sec = l.match(/^\[([\w-]+)\]/);
        if (sec) { inDepSection = /^(dependencies|dev-dependencies|build-dependencies)$/.test(sec[1]); return; }
        if (!inDepSection) return;
        const m = l.match(/^([a-zA-Z0-9_-]+)\s*=\s*"([^"]+)"/) || l.match(/^([a-zA-Z0-9_-]+)\s*=\s*\{\s*version\s*=\s*"([^"]+)"/);
        if (m && !/^(workspace|edition|rust-version)$/.test(m[1])) tasks.push({ i, name: m[1] });
      });
      if (!tasks.length) return null;
      const res = await Promise.all(tasks.slice(0, MAX_PER_ECOSYSTEM).map(async t => ({ ...t, v: await lk('cargo', t.name) })));
      const out = [...lines];
      const updates: Update[] = [];
      for (const t of res) {
        if (!t.v) continue;
        const cur = lines[t.i];
        const m = cur.match(/^([a-zA-Z0-9_-]+\s*=\s*")([^"]+)(")/) || cur.match(/^([a-zA-Z0-9_-]+\s*=\s*\{\s*version\s*=\s*")([^"]+)(")/);
        if (!m) continue;
        if (bare(m[2]) === bare(t.v)) continue;
        out[t.i] = cur.replace(`${m[2]}`, t.v);
        updates.push({ name: t.name, from: m[2], to: t.v, ecosystem: 'cargo', breaking: isBreaking(m[2], t.v) });
      }
      if (!updates.length) return null;
      return { updates, content: out.join('\n') };
    },
  },
  // Go — go.mod
  {
    ecosystem: 'go',
    match: p => p === 'go.mod' || p.endsWith('/go.mod'),
    update: async (content, lk) => {
      const lines = content.split('\n');
      const tasks: { i: number; mod: string }[] = [];
      lines.forEach((l, i) => {
        const t = l.trim();
        if (t.startsWith('go ') || t.startsWith('toolchain') || t.startsWith('//')) return;
        const m = t.match(/^([a-zA-Z0-9_.\-\/!]+)\/v?\d*\s+(v[\d.]+)/);
        if (m) tasks.push({ i, mod: m[1] });
      });
      if (!tasks.length) return null;
      const res = await Promise.all(tasks.slice(0, MAX_PER_ECOSYSTEM).map(async t => ({ ...t, v: await lk('go', t.mod) })));
      const out = [...lines];
      const updates: Update[] = [];
      for (const t of res) {
        if (!t.v) continue;
        const cur = lines[t.i];
        const m = cur.match(/^(\s*)([a-zA-Z0-9_.\-\/!]+\/v?\d*)\s+(v[\d.]+)/);
        if (!m) continue;
        if (bare(m[3]) === bare(t.v)) continue;
        out[t.i] = `${m[1]}${m[2]} ${t.v}`;
        updates.push({ name: t.mod, from: m[3], to: t.v, ecosystem: 'go', breaking: isBreaking(m[3], t.v) });
      }
      if (!updates.length) return null;
      return { updates, content: out.join('\n') };
    },
  },
  // Ruby — Gemfile
  {
    ecosystem: 'gem',
    match: p => p === 'Gemfile' || p.endsWith('/Gemfile') || p === 'gems.rb' || p.endsWith('/gems.rb'),
    update: async (content, lk) => {
      const lines = content.split('\n');
      const tasks: { i: number; name: string }[] = [];
      lines.forEach((l, i) => {
        const m = l.match(/gem\s+["']([a-zA-Z0-9_.-]+)["']/);
        if (m) tasks.push({ i, name: m[1] });
      });
      if (!tasks.length) return null;
      const res = await Promise.all(tasks.slice(0, MAX_PER_ECOSYSTEM).map(async t => ({ ...t, v: await lk('gem', t.name) })));
      const out = [...lines];
      const updates: Update[] = [];
      for (const t of res) {
        if (!t.v) continue;
        const cur = lines[t.i];
        const m = cur.match(/(gem\s+["'][a-zA-Z0-9_.-]+["']\s*,\s*["'])([^"']+)(["'])/);
        if (m) {
          if (bare(m[2]) === bare(t.v)) continue;
          out[t.i] = cur.replace(`${m[2]}`, t.v);
          updates.push({ name: t.name, from: m[2], to: t.v, ecosystem: 'gem', breaking: isBreaking(m[2], t.v) });
        } else {
          // bare gem "name" → pin to latest
          out[t.i] = cur.replace(/(gem\s+["'][a-zA-Z0-9_.-]+["'])(\s*)$/, `$1, "${t.v}"`);
          updates.push({ name: t.name, from: '(unpinned)', to: t.v, ecosystem: 'gem', breaking: false });
        }
      }
      if (!updates.length) return null;
      return { updates, content: out.join('\n') };
    },
  },
  // PHP — composer.json
  {
    ecosystem: 'composer',
    match: p => p === 'composer.json' || p.endsWith('/composer.json'),
    update: async (content, lk) => {
      let pkg: any; try { pkg = JSON.parse(content); } catch { return null; }
      const sections = ['require', 'require-dev'];
      const updates: Update[] = [];
      for (const sec of sections) {
        const deps = pkg[sec];
        if (!deps || typeof deps !== 'object') continue;
        const names = Object.keys(deps).filter(n => n !== 'php').slice(0, MAX_PER_ECOSYSTEM);
        const res = await Promise.all(names.map(async n => ({ n, v: await lk('composer', n) })));
        for (const { n, v } of res) {
          if (!v) continue;
          const cur = String(deps[n] || '');
          if (!cur || cur === '*') continue;
          if (bare(cur) !== bare(v)) {
            const nv = `^${v}`;
            deps[n] = nv;
            updates.push({ name: n, from: cur, to: nv, ecosystem: 'composer', breaking: isBreaking(cur, v) });
          }
        }
      }
      if (!updates.length) return null;
      return { updates, content: JSON.stringify(pkg, null, 4) };
    },
  },
  // Gradle — build.gradle / build.gradle.kts (Maven-coordinate deps)
  {
    ecosystem: 'maven',
    match: p => p.endsWith('build.gradle') || p.endsWith('build.gradle.kts'),
    update: async (content, lk) => {
      const depRe = /(implementation|api|compileOnly|runtimeOnly|testImplementation|testApi|annotationProcessor|platform)\s*[(]?\s*["']([a-zA-Z0-9_.-]+):([a-zA-Z0-9_.-]+):([^"']+)["']/g;
      const coords: { g: string; a: string; v: string }[] = [];
      let m: RegExpExecArray | null;
      while ((m = depRe.exec(content))) {
        if (!/\$\{/.test(m[4])) coords.push({ g: m[2], a: m[3], v: m[4] });
      }
      if (!coords.length) return null;
      const res = await Promise.all(coords.slice(0, MAX_PER_ECOSYSTEM).map(async c => ({ c, v: await lk('maven', `${c.g}:${c.a}`) })));
      let out = content;
      const updates: Update[] = [];
      for (const { c, v } of res) {
        if (!v || bare(c.v) === bare(v)) continue;
        const re = new RegExp(`(${c.g}:${c.a}:)${c.v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(["'])`);
        out = out.replace(re, `$1${v}$2`);
        updates.push({ name: `${c.g}:${c.a}`, from: c.v, to: v, ecosystem: 'maven', breaking: isBreaking(c.v, v) });
      }
      if (!updates.length) return null;
      return { updates, content: out };
    },
  },
  // Arduino — platformio.ini lib_deps
  {
    ecosystem: 'platformio',
    match: p => p === 'platformio.ini' || p.endsWith('/platformio.ini'),
    update: async (content, lk) => {
      const lines = content.split('\n');
      const tasks: { i: number; name: string }[] = [];
      let inLibDeps = false;
      lines.forEach((l, i) => {
        if (/^\[/.test(l)) { inLibDeps = /^\[lib_deps\]/.test(l.trim()); return; }
        if (!inLibDeps) return;
        const t = l.trim();
        if (!t || t.startsWith('#') || t.startsWith('=')) return;
        const m = t.match(/^([a-zA-Z0-9_.-]+)/);
        if (m) tasks.push({ i, name: m[1] });
      });
      if (!tasks.length) return null;
      const res = await Promise.all(tasks.slice(0, MAX_PER_ECOSYSTEM).map(async t => ({ ...t, v: await lk('platformio', t.name) })));
      const out = [...lines];
      const updates: Update[] = [];
      for (const t of res) {
        if (!t.v) continue;
        const cur = lines[t.i].trim();
        if (cur === t.name) {
          out[t.i] = lines[t.i].replace(t.name, `${t.name}@${t.v}`);
          updates.push({ name: t.name, from: '(unpinned)', to: t.v, ecosystem: 'platformio', breaking: false });
        } else {
          const m = cur.match(/^([a-zA-Z0-9_.-]+)@(.+)/);
          if (m && bare(m[2]) !== bare(t.v)) {
            out[t.i] = lines[t.i].replace(`${m[2]}`, t.v);
            updates.push({ name: t.name, from: m[2], to: t.v, ecosystem: 'platformio', breaking: isBreaking(m[2], t.v) });
          }
        }
      }
      if (!updates.length) return null;
      return { updates, content: out.join('\n') };
    },
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
export default async function (req: Request): Promise<Response> {
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

    const allUpdates: Update[] = [];
    const fileOps: { path: string; action: string; ecosystem: string }[] = [];

    // Run every matching updater against every file. A single file only ever
    // matches one updater (manifests are distinct by name), but the loop is
    // file-driven so new manifests are picked up automatically.
    for (const file of files) {
      const path: string = file.path || '';
      for (const updater of REGISTRY) {
        if (!updater.match(path)) continue;
        try {
          const result = await updater.update(file.content || '', lookup);
          if (result && result.updates.length) {
            await base44.entities.ProjectFile.update(file.id, { content: result.content, language: detectLanguage(path) });
            allUpdates.push(...result.updates);
            fileOps.push({ path, action: 'update', ecosystem: updater.ecosystem });
          }
        } catch (e) {
          console.error(`Dep sync failed for ${path}:`, (e as any)?.message || e);
        }
      }
    }

    await logUsage(base44, 'chat_simple', projectId, project.name, { action: 'sync_deps', updated: allUpdates.length });

    const breaking = allUpdates.filter(u => u.breaking);
    let reply: string;
    if (allUpdates.length === 0) {
      reply = '// DEPS SYNCED — All dependencies are already at their latest versions across every detected manifest. Morpheus is coding against current references.';
    } else {
      const byEco: Record<string, Update[]> = {};
      for (const u of allUpdates) (byEco[u.ecosystem] ||= []).push(u);
      const sections = Object.entries(byEco).map(([eco, list]) =>
        `  [${eco}] ${list.map(u => `${u.name}: ${u.from || '?'} → ${u.to}${u.breaking ? ' ⚠ major' : ''}`).join(', ')}`
      );
      reply = `[DEPS SYNCED] Updated ${allUpdates.length} package(s) across ${fileOps.length} manifest(s):\n${sections.join('\n')}\n\n// References refreshed. Morpheus will use these versions going forward.`;
      if (breaking.length) {
        reply += `\n\n// ⚠ ${breaking.length} major-version bump(s) flagged — review for breaking changes before rebuilding.`;
      }
    }

    return Response.json({ reply, fileOperations: fileOps, updatedCount: allUpdates.length, updates: allUpdates });
  } catch (error) {
    console.error('Sync deps error:', error?.message || error);
    return Response.json({ error: error?.message || 'Unknown error' }, { status: 500 });
  }
}