// Linux Binary compile target — produces a native Linux binary.
// Node: @yao-pkg/pkg. Python: PyInstaller. Supports x64 and arm64.

import {
  isNodeProject, isPythonProject, parsePackageJson, detectPythonEntry,
  detectDataDirs, detectHiddenImports, detectNodeVersion, detectPythonVersion,
  detectBuildScript, detectPackageHints, cloneFiles
} from './utils.js';

export const linuxBinary = {
  id: 'linux-binary',
  label: 'Linux Binary',
  runner: 'ubuntu-latest',

  validate(files) {
    const warnings = [];
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

  scaffold(files) {
    return { files: cloneFiles(files), generated: [], warnings: [] };
  },

  buildSteps(files) {
    if (isNodeProject(files)) {
      const nodeVersion = detectNodeVersion(files) || '24';
      return [
        { uses: 'actions/checkout@v4' },
        {
          uses: 'actions/setup-node@v4',
          with: { 'node-version': `'${nodeVersion}'` }
        },
        { run: 'npm install' },
        { run: 'npx @yao-pkg/pkg . --targets node24-linux-x64 --output app' },
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
    const packageHints = detectPackageHints(files);
    const pythonVersion = detectPythonVersion(files) || '3.12';
    const buildScript = detectBuildScript(files);

    const setupSteps = [
      { uses: 'actions/checkout@v4' },
      {
        uses: 'actions/setup-python@v5',
        with: { 'python-version': `'${pythonVersion}'` }
      },
      { run: 'pip install -r requirements.txt 2>/dev/null || true' },
      { run: 'pip install pyinstaller' },
    ];

    // Run the project's own build.py when it has one, instead of silently
    // overriding it with a weaker reconstructed pyinstaller command — see
    // utils.js's detectBuildScript for why (GUI/data-heavy packages need
    // collect-submodules/collect-data flags no source-regex scan can find).
    if (buildScript) {
      return [
        ...setupSteps,
        {
          name: "Build with the project's own build script",
          run: [
            `python ${buildScript}`,
            'ls dist/',
            'compgen -G "dist/*" > /dev/null || { echo "Build script produced nothing in dist/"; exit 1; }'
          ].join('\n')
        },
        { run: 'tar -czf app.tar.gz -C dist .' }
      ];
    }

    const args = ['--onefile', '--name', 'app'];
    for (const dir of dataDirs) {
      args.push(`--add-data "${dir}:${dir}"`);
    }
    for (const imp of hiddenImports) {
      args.push(`--hidden-import ${imp}`);
    }
    // Known-tricky packages (PyQt6, pandas, etc.) — see utils.js's
    // detectPackageHints/KNOWN_PACKAGE_HINTS.
    args.push(...packageHints);
    args.push(entry);

    return [
      ...setupSteps,
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
