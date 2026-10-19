// Shared helpers used across compile-target adapters.

import { ProjectFile } from './types.ts';

export function hasFile(files: ProjectFile[], path: string): boolean {
  return files.some(f => f.path === path);
}

export function hasAny(files: ProjectFile[], paths: string[]): boolean {
  return paths.some(p => files.some(f => f.path === p || f.path.endsWith('/' + p)));
}

export function hasPattern(files: ProjectFile[], pattern: RegExp): boolean {
  return files.some(f => pattern.test(f.path));
}

export function getFile(files: ProjectFile[], path: string): ProjectFile | undefined {
  return files.find(f => f.path === path);
}

export function getFileContent(files: ProjectFile[], path: string): string | undefined {
  return files.find(f => f.path === path)?.content;
}

// Clone the file array so scaffolding never mutates the caller's data
export function cloneFiles(files: ProjectFile[]): ProjectFile[] {
  return files.map(f => ({ path: f.path, content: f.content }));
}

// Safely parse package.json; returns null on invalid JSON
export function parsePackageJson(files: ProjectFile[]): any | null {
  const pkg = getFile(files, 'package.json');
  if (!pkg) return null;
  try {
    return JSON.parse(pkg.content);
  } catch {
    return null;
  }
}

// Detect if the project is Node-based (has package.json)
export function isNodeProject(files: ProjectFile[]): boolean {
  return hasFile(files, 'package.json');
}

// Detect if the project is Python-based (has requirements.txt, setup.py, pyproject.toml, or .py files)
export function isPythonProject(files: ProjectFile[]): boolean {
  return hasAny(files, ['requirements.txt', 'setup.py', 'pyproject.toml']) ||
    hasPattern(files, /\.py$/);
}

// Detect web framework from package.json dependencies
export function detectWebFramework(files: ProjectFile[]): string | null {
  const pkg = parsePackageJson(files);
  if (!pkg || !pkg.dependencies) return null;
  const deps = { ...pkg.dependencies, ...(pkg.devDependencies || {}) };
  if (deps['next']) return 'next';
  if (deps['nuxt']) return 'nuxt';
  if (deps['@angular/core']) return 'angular';
  if (deps['svelte']) return 'svelte';
  if (deps['vue']) return 'vue';
  if (deps['react']) return 'react';
  return null;
}

// Detect build output directory based on framework
export function detectBuildOutputDir(files: ProjectFile[]): string {
  const framework = detectWebFramework(files);
  switch (framework) {
    case 'next': return 'out';
    case 'nuxt': return '.output/public';
    case 'angular': return 'dist';
    default: return 'dist';
  }
}

// Check if the project uses SPA routing (React Router, Vue Router, etc.)
export function usesSPARouting(files: ProjectFile[]): boolean {
  const pkg = parsePackageJson(files);
  if (!pkg) return false;
  const deps = { ...pkg.dependencies, ...(pkg.devDependencies || {}) };
  return !!(deps['react-router-dom'] || deps['react-router'] || deps['vue-router'] ||
    deps['@tanstack/react-router'] || deps['@sveltejs/kit']);
}

// Detect Python entry point file
export function detectPythonEntry(files: ProjectFile[]): string | null {
  const candidates = ['main.py', 'app.py', 'src/main.py', 'src/app.py', 'run.py', 'start.py'];
  for (const c of candidates) {
    if (hasFile(files, c)) return c;
  }
  // Fall back to any .py file with a main guard
  for (const f of files) {
    if (f.path.endsWith('.py') && /if\s+__name__\s*==\s*['"]__main__['"]/.test(f.content)) {
      return f.path;
    }
  }
  return null;
}

// Detect data directories that PyInstaller should bundle
export function detectDataDirs(files: ProjectFile[]): string[] {
  const dirs = new Set<string>();
  const dataDirPatterns = [/^templates?\//, /^static\//, /^assets?\//, /^data\//, /^config\//, /^resources?\//];
  for (const f of files) {
    for (const pattern of dataDirPatterns) {
      if (pattern.test(f.path)) {
        dirs.add(f.path.split('/')[0]);
      }
    }
  }
  return Array.from(dirs);
}

// Detect hidden imports for PyInstaller (common dynamic import patterns)
export function detectHiddenImports(files: ProjectFile[]): string[] {
  const hidden = new Set<string>();
  for (const f of files) {
    if (!f.path.endsWith('.py')) continue;
    // importlib.import_module("X")
    const importlibMatches = f.content.matchAll(/importlib\.import_module\s*\(\s*['"]([^'"]+)['"]/g);
    for (const m of importlibMatches) hidden.add(m[1]);
    // __import__("X")
    const dunderMatches = f.content.matchAll(/__import__\s*\(\s*['"]([^'"]+)['"]/g);
    for (const m of dunderMatches) hidden.add(m[1]);
    // pkg_resources.iter_entry_points("X")
    const entryMatches = f.content.matchAll(/pkg_resources\.iter_entry_points\s*\(\s*['"]([^'"]+)['"]/g);
    for (const m of entryMatches) hidden.add(m[1]);
  }
  return Array.from(hidden);
}

// Detect the Node.js version a project targets. Reads .nvmrc or
// package.json engines.node. Returns a version string (e.g. "18", "20.11.0")
// or null if not specified. Used to pick the setup-node action version instead
// of hardcoding 20 — a project pinned to Node 18 can break under Node 20.
export function detectNodeVersion(files: ProjectFile[]): string | null {
  // .nvmrc — just the version, one line
  const nvmrc = getFile(files, '.nvmrc');
  if (nvmrc) {
    const v = nvmrc.content.trim().replace(/^v/, '');
    if (v) return v;
  }
  // package.json engines.node — can be a range like ">=18" or "18.x" or "20"
  const pkg = parsePackageJson(files);
  if (pkg?.engines?.node) {
    const raw = String(pkg.engines.node);
    // Extract the first numeric version from the range constraint
    const match = raw.match(/(\d+(?:\.\d+)?(?:\.\d+)?)/);
    if (match) return match[1];
  }
  return null;
}

// Detect the Python version a project targets. Reads .python-version or
// pyproject.toml requires-python. Returns a version string (e.g. "3.10")
// or null if not specified. Used to pick the setup-python action version
// instead of hardcoding 3.12 — a project requiring 3.10 can break under 3.12.
export function detectPythonVersion(files: ProjectFile[]): string | null {
  // .python-version — just the version, one line
  const pv = getFile(files, '.python-version');
  if (pv) {
    const v = pv.content.trim().replace(/^v/, '');
    if (v) return v;
  }
  // pyproject.toml requires-python — can be a range like ">=3.10"
  const pyproject = getFile(files, 'pyproject.toml');
  if (pyproject) {
    const match = pyproject.content.match(/requires-python\s*=\s*["']([^"']+)["']/);
    if (match) {
      const numMatch = match[1].match(/(\d+(?:\.\d+)?(?:\.\d+)?)/);
      if (numMatch) return numMatch[1];
    }
  }
  // setup.cfg python_requires — legacy but still used
  const setupCfg = getFile(files, 'setup.cfg');
  if (setupCfg) {
    const match = setupCfg.content.match(/python_requires\s*=\s*([^\s\n]+)/);
    if (match) {
      const numMatch = match[1].match(/(\d+(?:\.\d+)?(?:\.\d+)?)/);
      if (numMatch) return numMatch[1];
    }
  }
  return null;
}

// Detect Gradle version from gradle/wrapper/gradle-wrapper.properties
export function detectGradleVersion(files: ProjectFile[]): string | null {
  const props = getFile(files, 'gradle/wrapper/gradle-wrapper.properties');
  if (!props) return null;
  const match = props.content.match(/gradle-([0-9]+\.[0-9]+(?:\.[0-9]+)?)-[a-z]+\.zip/);
  return match ? match[1] : null;
}

// Detect the Android Gradle Plugin (AGP) version from the root build.gradle.
// Handles both the plugins DSL style and the legacy buildscript classpath style.
// Returns the version string (e.g. "8.1.0") or null if not found.
export function detectAgpVersion(files: ProjectFile[]): string | null {
  const rootBuild = getFile(files, 'build.gradle') || getFile(files, 'build.gradle.kts');
  if (!rootBuild) return null;
  // Plugins DSL: id 'com.android.application' version '8.1.0' apply false
  const pluginsMatch = rootBuild.content.match(/com\.android\.application['"]\s+version\s+['"]([0-9]+\.[0-9]+\.[0-9]+)['"]/);
  if (pluginsMatch) return pluginsMatch[1];
  // Buildscript classpath: classpath 'com.android.tools.build:gradle:8.1.0'
  const classpathMatch = rootBuild.content.match(/com\.android\.tools\.build:gradle:([0-9]+\.[0-9]+\.[0-9]+)/);
  if (classpathMatch) return classpathMatch[1];
  return null;
}

// Map an AGP version to the Gradle version it was tested with.
// Using a Gradle version newer than the AGP version supports causes
// ClassNotFoundException / NoSuchMethodError failures on GitHub Actions.
export function gradleVersionForAgp(agpVersion: string | null): string {
  if (!agpVersion) return '8.5'; // safe default when AGP version can't be detected
  const [major, minor] = agpVersion.split('.').map(n => parseInt(n, 10));
  if (major === 8) {
    switch (minor) {
      case 0: return '8.0';
      case 1: return '8.0';
      case 2: return '8.2';
      case 3: return '8.4';
      case 4: return '8.6';
      case 5: return '8.7';
      default: return '8.7'; // AGP 8.6+ → Gradle 8.7+
    }
  }
  if (major === 7) return '7.6'; // AGP 7.x → Gradle 7.x
  return '8.5'; // unknown — safe default
}

// Detect Android package name from source file paths or existing manifest
export function detectAndroidPackageName(files: ProjectFile[]): string {
  // Derive from source path structure: app/src/main/java/com/example/app/X.kt
  for (const f of files) {
    const m = f.path.match(/app\/src\/main\/(?:java|kotlin)\/((?:[a-z][a-z0-9_]*\/)+)[A-Z]/);
    if (m) return m[1].replace(/\/$/, '').replace(/\//g, '.');
  }
  // Read from existing manifest
  const manifest = files.find(f => /AndroidManifest\.xml$/.test(f.path));
  if (manifest) {
    const pkgMatch = manifest.content.match(/package\s*=\s*["']([^"']+)["']/);
    if (pkgMatch) return pkgMatch[1];
  }
  return 'com.morpheus.app';
}

// Check if the Android project defines a release signing config
export function hasReleaseSigningConfig(files: ProjectFile[]): boolean {
  const buildGradle = getFile(files, 'app/build.gradle') || getFile(files, 'app/build.gradle.kts');
  if (!buildGradle) return false;
  return /release\s*\{[\s\S]*?signingConfig/.test(buildGradle.content);
}

// Detect icon file for the target platform
export function detectIcon(files: ProjectFile[], extensions: string[]): string | null {
  for (const ext of extensions) {
    const icon = files.find(f =>
      f.path.toLowerCase().endsWith(ext) &&
      (f.path.toLowerCase().includes('icon') || f.path.toLowerCase().includes('app.') || f.path === `icon${ext}`)
    );
    if (icon) return icon.path;
  }
  return null;
}