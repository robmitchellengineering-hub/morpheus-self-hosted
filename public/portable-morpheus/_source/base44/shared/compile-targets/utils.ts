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

// Detect Gradle version from gradle/wrapper/gradle-wrapper.properties
export function detectGradleVersion(files: ProjectFile[]): string | null {
  const props = getFile(files, 'gradle/wrapper/gradle-wrapper.properties');
  if (!props) return null;
  const match = props.content.match(/gradle-([0-9]+\.[0-9]+(?:\.[0-9]+)?)-[a-z]+\.zip/);
  return match ? match[1] : null;
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