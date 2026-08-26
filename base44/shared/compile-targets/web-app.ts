// Web App compile target — builds a static web app and packages it as a ZIP.
// Detects the framework (React, Vue, Svelte, Next, etc.) and handles SPA routing.

import { CompileTarget, ProjectFile, BuildStep } from './types.ts';
import {
  hasFile, parsePackageJson, detectWebFramework, detectBuildOutputDir,
  usesSPARouting, detectNodeVersion, cloneFiles, getFile
} from './utils.ts';

export const webApp: CompileTarget = {
  id: 'web-app',
  label: 'Web App',
  runner: 'ubuntu-latest',

  validate(files: ProjectFile[]) {
    const warnings: string[] = [];
    if (!hasFile(files, 'package.json')) {
      return { valid: false, error: 'web-app target requires a package.json with a build script.', warnings };
    }
    const pkg = parsePackageJson(files);
    if (pkg) {
      if (!pkg.scripts || (!pkg.scripts.build && !pkg.scripts.dist)) {
        warnings.push('package.json has no "build" script — workflow will zip the project as-is.');
      }
    } else {
      warnings.push('package.json is not valid JSON — build may fail.');
    }
    return { valid: true, warnings };
  },

  scaffold(files: ProjectFile[]) {
    const generated: string[] = [];
    const warnings: string[] = [];
    const augmented = cloneFiles(files);

    // Auto-generate SPA routing fallback if the project uses a router
    // and doesn't already have a hosting config
    if (usesSPARouting(augmented) &&
        !hasFile(augmented, '_redirects') &&
        !hasFile(augmented, 'vercel.json') &&
        !hasFile(augmented, 'netlify.toml')) {
      augmented.push({
        path: '_redirects',
        content: '/*    /index.html   200\n'
      });
      generated.push('_redirects');
      warnings.push('Auto-generated _redirects for SPA routing (React Router / Vue Router).');
    }

    return { files: augmented, generated, warnings };
  },

  buildSteps(files: ProjectFile[]): BuildStep[] {
    const framework = detectWebFramework(files);
    const outputDir = detectBuildOutputDir(files);
    // Use the project's declared Node version if specified (.nvmrc or
    // package.json engines.node); fall back to 20 LTS.
    const nodeVersion = detectNodeVersion(files) || '20';

    return [
      { uses: 'actions/checkout@v4' },
      {
        uses: 'actions/setup-node@v4',
        with: { 'node-version': `'${nodeVersion}'` }
      },
      {
        name: 'Cache npm',
        uses: 'actions/cache@v4',
        with: {
          path: '~/.npm',
          key: "npm-${{ runner.os }}-${{ hashFiles('package.json', 'package-lock.json') }}",
          'restore-keys': 'npm-${{ runner.os }}-'
        }
      },
      { run: 'npm install' },
      { run: 'npm run build --if-present' },
      {
        name: 'Package web app',
        run: [
          `# Try common build output directories, fall back to zipping the project`,
          `if [ -d ${outputDir} ]; then zip -r release.zip ${outputDir};`,
          `elif [ -d dist ]; then zip -r release.zip dist;`,
          `elif [ -d build ]; then zip -r release.zip build;`,
          `else zip -r release.zip . -x "node_modules/*" -x ".git/*" -x "release.zip"; fi`,
          `test -f release.zip || { echo "No web build output found"; exit 1; }`
        ].join('\n')
      }
    ];
  },

  artifact: {
    glob: 'release.zip',
    isGlob: false,
    artifactName: 'web-app.zip',
    verifyCommand: 'test -f release.zip || { echo "No release.zip produced"; exit 1; }'
  }
};

export default webApp;