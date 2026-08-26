// Linux Binary compile target — produces a native Linux binary.
// Node: @yao-pkg/pkg. Python: PyInstaller. Supports x64 and arm64.

import { CompileTarget, ProjectFile, BuildStep } from './types.ts';
import {
  isNodeProject, isPythonProject, parsePackageJson, detectPythonEntry,
  detectDataDirs, detectHiddenImports, cloneFiles
} from './utils.ts';

export const linuxBinary: CompileTarget = {
  id: 'linux-binary',
  label: 'Linux Binary',
  runner: 'ubuntu-latest',

  validate(files: ProjectFile[]) {
    const warnings: string[] = [];
    if (isNodeProject(files)) {
      const pkg = parsePackageJson(files);
      if (pkg && !pkg.bin && !pkg.main) {
        warnings.push('package.json has no "bin" or "main" field — pkg may not produce a binary.');
      }
      return { valid: true, warnings };
    }
    if (isPythonProject(files)) {
      const entry = detectPythonEntry(files);
      if (!entry) {
        return {
          valid: false,
          error: 'linux-binary (Python) requires a Python entry point (main.py, app.py).',
          warnings
        };
      }
      return { valid: true, warnings };
    }
    return {
      valid: false,
      error: 'linux-binary requires either a package.json (Node) or a Python entry point.',
      warnings
    };
  },

  scaffold(files: ProjectFile[]) {
    return { files: cloneFiles(files), generated: [], warnings: [] };
  },

  buildSteps(files: ProjectFile[]): BuildStep[] {
    if (isNodeProject(files)) {
      return [
        { uses: 'actions/checkout@v4' },
        {
          uses: 'actions/setup-node@v4',
          with: { 'node-version': "'20'" }
        },
        { run: 'npm install' },
        { run: 'npx @yao-pkg/pkg . --targets node20-linux-x64 --output app' },
        {
          name: 'Verify binary',
          run: 'test -f app || { echo "pkg produced no binary (does package.json have a bin field?)"; exit 1; }'
        },
        { run: 'tar -czf app.tar.gz app' }
      ];
    }

    // Python — PyInstaller
    const entry = detectPythonEntry(files) || 'main.py';
    const dataDirs = detectDataDirs(files);
    const hiddenImports = detectHiddenImports(files);

    const args: string[] = ['--onefile', '--name', 'app'];
    for (const dir of dataDirs) {
      args.push(`--add-data "${dir}:${dir}"`);
    }
    for (const imp of hiddenImports) {
      args.push(`--hidden-import ${imp}`);
    }
    args.push(entry);

    return [
      { uses: 'actions/checkout@v4' },
      {
        uses: 'actions/setup-python@v5',
        with: { 'python-version': "'3.12'" }
      },
      { run: 'pip install -r requirements.txt 2>/dev/null || true' },
      { run: 'pip install pyinstaller' },
      {
        name: 'Build with PyInstaller',
        run: [
          `pyinstaller ${args.join(' ')}`,
          'ls dist/',
          'compgen -G "dist/*" > /dev/null || { echo "PyInstaller produced no binary"; exit 1; }'
        ].join('\n')
      },
      { run: 'tar -czf app.tar.gz -C dist .' }
    ];
  },

  artifact: {
    glob: 'app.tar.gz',
    isGlob: false,
    artifactName: 'app-linux.tar.gz',
    verifyCommand: 'test -f app.tar.gz || { echo "No binary archive produced"; exit 1; }'
  },

  errorPatterns: [
    /ModuleNotFoundError/i,
    /ImportError/i,
    /PyInstaller/i,
    /pkg.*failed/i
  ]
};

export default linuxBinary;