// Shared helpers used across compile-target adapters.

export function hasFile(files, path) {
  return files.some(f => f.path === path);
}

export function hasAny(files, paths) {
  return paths.some(p => files.some(f => f.path === p || f.path.endsWith('/' + p)));
}

export function hasPattern(files, pattern) {
  return files.some(f => pattern.test(f.path));
}

export function getFile(files, path) {
  return files.find(f => f.path === path);
}

export function getFileContent(files, path) {
  return files.find(f => f.path === path)?.content;
}

// Clone the file array so scaffolding never mutates the caller's data
export function cloneFiles(files) {
  return files.map(f => ({ path: f.path, content: f.content }));
}

// Safely parse package.json; returns null on invalid JSON
export function parsePackageJson(files) {
  const pkg = getFile(files, 'package.json');
  if (!pkg) return null;
  try {
    return JSON.parse(pkg.content);
  } catch {
    return null;
  }
}

// Detect if the project is Node-based. A bare package.json isn't enough —
// Construct/self-dev sometimes leaves one behind as pure project metadata
// (2026-09-15, the Wikidata Batch Uploader incident: a package.json with no
// "main" field, no dependencies, and a scripts.start pointing at an
// index.js that was never created, on an otherwise 100%-Python PyQt6
// project — every compile target's Node-vs-Python branch was silently
// picking Node and trying to bundle main.py with a JS packager). Require
// actual evidence of real Node code or tooling instead of just the file's
// existence: a real JS/TS source file present, or a non-empty
// dependencies/devDependencies list.
export function isNodeProject(files) {
  if (!hasFile(files, 'package.json')) return false;
  if (hasPattern(files, /\.(js|mjs|cjs|ts|tsx|jsx)$/)) return true;
  const pkg = parsePackageJson(files);
  const depCount = Object.keys(pkg?.dependencies || {}).length + Object.keys(pkg?.devDependencies || {}).length;
  return depCount > 0;
}

// Detect if the project is Python-based (has requirements.txt, setup.py, pyproject.toml, or .py files)
export function isPythonProject(files) {
  return hasAny(files, ['requirements.txt', 'setup.py', 'pyproject.toml']) ||
    hasPattern(files, /\.py$/);
}

// Resolves a Node project's real entry file from package.json's "main" (or
// the first "bin" command) — falls back to "index.js" only when neither is
// set (npm's own default when "main" is omitted). For targets that bake a
// launcher path directly into a systemd ExecStart/similar (rpi-distro.js,
// linux-distro.js) rather than running `npm start`: hardcoding "index.js"
// broke any project whose real entry lived elsewhere (e.g. "main":
// "src/server.js") — the unit pointed at a file that doesn't exist, and the
// app crash-loops on first boot with nothing in the compile CI to catch it
// (the image itself still "builds successfully").
export function detectNodeEntry(files) {
  const pkg = parsePackageJson(files);
  if (pkg?.main && typeof pkg.main === 'string') return pkg.main;
  if (pkg?.bin) {
    const bin = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin)[0];
    if (typeof bin === 'string') return bin;
  }
  return 'index.js';
}

// Detect a Swift Package Manager project (Package.swift at the project
// root). Used by mac-app.js to route real native macOS Swift apps to a
// `swift build` step instead of the Node/pkg path. This matters because a
// project can have BOTH a Package.swift AND a package.json (a JS launcher
// shipped as a documented "convenience wrapper" that execs a pre-built
// Swift binary) — isNodeProject(files) alone would wrongly claim that
// project. Swift detection must be checked first, ahead of isNodeProject,
// wherever a project could be either. See mac-app.js's Swift branch
// (2026-09-04, Rob's AnyPDF app) for the incident that surfaced this.
export function isSwiftProject(files) {
  return hasFile(files, 'Package.swift');
}

// Detect the product name Swift Package Manager will actually build, by
// reading Package.swift. Prefers the .executableTarget(name: "...") since
// that's the binary `swift build` produces; falls back to the top-level
// Package(name: "...") if no executable target is found (or the regex
// can't match some more exotic Package.swift shape).
export function detectSwiftExecutableName(files) {
  const pkg = getFile(files, 'Package.swift');
  if (!pkg) return null;
  const execMatch = pkg.content.match(/\.executableTarget\(\s*name:\s*"([^"]+)"/);
  if (execMatch) return execMatch[1];
  const nameMatch = pkg.content.match(/Package\(\s*name:\s*"([^"]+)"/);
  if (nameMatch) return nameMatch[1];
  return null;
}

// Detect web framework from package.json dependencies
export function detectWebFramework(files) {
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
export function detectBuildOutputDir(files) {
  const framework = detectWebFramework(files);
  switch (framework) {
    case 'next': return 'out';
    case 'nuxt': return '.output/public';
    case 'angular': return 'dist';
    default: return 'dist';
  }
}

// Check if the project uses SPA routing (React Router, Vue Router, etc.)
export function usesSPARouting(files) {
  const pkg = parsePackageJson(files);
  if (!pkg) return false;
  const deps = { ...pkg.dependencies, ...(pkg.devDependencies || {}) };
  return !!(deps['react-router-dom'] || deps['react-router'] || deps['vue-router'] ||
    deps['@tanstack/react-router'] || deps['@sveltejs/kit']);
}

// Detect Python entry point file
export function detectPythonEntry(files) {
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
export function detectDataDirs(files) {
  const dirs = new Set();
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
export function detectHiddenImports(files) {
  const hidden = new Set();
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

// Does this project ship its own PyInstaller build script? (2026-09-15,
// the Wikidata Batch Uploader incident — "chat and compile fighting each
// other" — self-dev had already hand-tuned build.py with the
// --collect-submodules/--collect-data/--hidden-import flags a real PyQt6 +
// pandas app needs (see detectPackageHints below for why those can never
// be found by source-regex scanning), but the compile pipeline silently
// ignored it and kept regenerating its own weaker pyinstaller invocation
// every time. When a project has done the work to get its own build right,
// run THAT instead of overriding it.
export function detectBuildScript(files) {
  return hasFile(files, 'build.py') ? 'build.py' : null;
}

// Parse dependency names out of requirements.txt (also usable for a
// pyproject.toml-style one-per-line block, same format once extracted).
// Moved here from python-package.js so every Python-capable target shares
// one parser instead of each reinventing it.
export function parseRequirementsTxt(content) {
  return content.split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#') && !l.startsWith('-'))
    .map(l => l.split('==')[0].split('>=')[0].split('<=')[0].split('~=')[0].trim())
    .filter(l => l);
}

// Extra PyInstaller args a package is known to need, keyed by lowercased
// dependency name. These exist because PyInstaller's default import-
// following can't see them: a Qt binding's C-extension internals (PyQt6.sip)
// and pandas' dynamically-loaded submodules are never spelled out as a
// literal Python `import` statement anywhere in user source — the same
// reason detectHiddenImports() above structurally can't catch them no
// matter how many patterns it grows. Not trying to be exhaustive, just
// closing the concrete gaps that have actually broken a real build.
const KNOWN_PACKAGE_HINTS = {
  pyqt6: ['--collect-submodules', 'PyQt6', '--collect-data', 'PyQt6', '--hidden-import', 'PyQt6.sip'],
  pyside6: ['--collect-submodules', 'PySide6', '--collect-data', 'PySide6'],
  pandas: ['--collect-submodules', 'pandas'],
  numpy: ['--collect-submodules', 'numpy'],
};

// Detect known-tricky packages from requirements.txt and return the extra
// PyInstaller args they need, flattened. Only used as a fallback when the
// project has no build.py of its own (see detectBuildScript above) — a
// project that already solved this itself doesn't need us guessing too.
export function detectPackageHints(files) {
  const req = getFile(files, 'requirements.txt');
  if (!req) return [];
  const deps = parseRequirementsTxt(req.content).map((d) => d.toLowerCase());
  const args = [];
  for (const dep of deps) {
    if (KNOWN_PACKAGE_HINTS[dep]) args.push(...KNOWN_PACKAGE_HINTS[dep]);
  }
  return args;
}

// Prefer a pinned lock file over requirements.txt when a project has one —
// the Wikidata Batch Uploader's own README is explicit that its build is
// only reproducible via `pip install -r requirements-lock.txt` (which also
// pins pyinstaller itself), and that build.py assumes that's already been
// run — build.py itself never installs anything. A generated workflow that
// only ever installs unpinned requirements.txt + a separately-unpinned
// `pip install pyinstaller` skips exactly the reproducibility a project
// went to the trouble of locking down. Falls back to requirements.txt
// (current behavior) when there's no lock file.
export function detectRequirementsFile(files) {
  if (hasFile(files, 'requirements-lock.txt')) return 'requirements-lock.txt';
  if (hasFile(files, 'requirements.txt')) return 'requirements.txt';
  return null;
}

// Does the given requirements file already pin pyinstaller itself? If so,
// a separate unpinned `pip install pyinstaller` afterward would upgrade
// past that pin and defeat the point of locking it — check rather than
// assume, since not every project's lock file necessarily includes it.
export function requirementsFileIncludesPyinstaller(files, requirementsFile) {
  if (!requirementsFile) return false;
  const f = getFile(files, requirementsFile);
  if (!f) return false;
  return parseRequirementsTxt(f.content).some((d) => d.toLowerCase() === 'pyinstaller');
}

// Detect the Node.js version a project targets. Reads .nvmrc or
// package.json engines.node. Returns a version string (e.g. "18", "20.11.0")
// or null if not specified. Used to pick the setup-node action version instead
// of hardcoding 20 — a project pinned to Node 18 can break under Node 20.
export function detectNodeVersion(files) {
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
export function detectPythonVersion(files) {
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
export function detectGradleVersion(files) {
  const props = getFile(files, 'gradle/wrapper/gradle-wrapper.properties');
  if (!props) return null;
  const match = props.content.match(/gradle-([0-9]+\.[0-9]+(?:\.[0-9]+)?)-[a-z]+\.zip/);
  return match ? match[1] : null;
}

// Detect the Android Gradle Plugin (AGP) version from the root build.gradle.
// Handles both the plugins DSL style and the legacy buildscript classpath style.
// Returns the version string (e.g. "8.1.0") or null if not found.
export function detectAgpVersion(files) {
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
export function gradleVersionForAgp(agpVersion) {
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
export function detectAndroidPackageName(files) {
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
export function hasReleaseSigningConfig(files) {
  const buildGradle = getFile(files, 'app/build.gradle') || getFile(files, 'app/build.gradle.kts');
  if (!buildGradle) return false;
  return /release\s*\{[\s\S]*?signingConfig/.test(buildGradle.content);
}

// Detect icon file for the target platform
export function detectIcon(files, extensions) {
  for (const ext of extensions) {
    const icon = files.find(f =>
      f.path.toLowerCase().endsWith(ext) &&
      (f.path.toLowerCase().includes('icon') || f.path.toLowerCase().includes('app.') || f.path === `icon${ext}`)
    );
    if (icon) return icon.path;
  }
  return null;
}
