// Windows EXE compile target — produces a .exe executable.
// Detects Node (pkg) vs Python (PyInstaller), bundles icons, data files,
// and hidden imports for PyInstaller to avoid runtime ModuleNotFoundError.
// Runs on a Windows runner with PowerShell to produce a genuine .exe.

import {
  isNodeProject, isPythonProject, parsePackageJson, detectPythonEntry,
  detectDataDirs, detectHiddenImports, detectIcon, detectNodeVersion,
  detectPythonVersion, cloneFiles
} from './utils.js';

export const windowsExe = {
  id: 'windows-exe',
  label: 'Windows EXE',
  runner: 'windows-latest',

  validate(files) {
    const warnings = [];
    if (isNodeProject(files)) {
      const pkg = parsePackageJson(files);
      if (pkg && !pkg.bin && !pkg.main) {
        warnings.push('package.json has no "bin" or "main" field — pkg may not produce an executable.');
      }
      // Warn about native modules that pkg can't bundle
      if (pkg?.dependencies) {
        const nativeMods = Object.keys(pkg.dependencies).filter(d =>
          ['sharp', 'better-sqlite3', 'sqlite3', 'canvas', 'node-canvas', 'bcrypt', 'node-sass'].includes(d)
        );
        if (nativeMods.length > 0) {
          warnings.push(`Native modules detected (${nativeMods.join(', ')}) — @yao-pkg/pkg cannot bundle .node modules. The build may fail at runtime.`);
        }
      }
      return { valid: true, warnings };
    }
    if (isPythonProject(files)) {
      const entry = detectPythonEntry(files);
      if (!entry) {
        return {
          valid: false,
          error: 'windows-exe (Python) requires a Python entry point (main.py, app.py, or a file with if __name__ == "__main__").',
          warnings
        };
      }
      return { valid: true, warnings };
    }
    return {
      valid: false,
      error: 'windows-exe requires either a package.json (Node) or a Python entry point (main.py/app.py).',
      warnings
    };
  },

  scaffold(files) {
    return { files: cloneFiles(files), generated: [], warnings: [] };
  },

  buildSteps(files) {
    if (isNodeProject(files)) {
      const nodeVersion = detectNodeVersion(files) || '20';
      return [
        { uses: 'actions/checkout@v4' },
        {
          uses: 'actions/setup-node@v4',
          with: { 'node-version': `'${nodeVersion}'` }
        },
        { run: 'npm install' },
        { run: 'npx @yao-pkg/pkg . --targets node20-win-x64 --output app.exe' },
        {
          name: 'Verify executable',
          run: 'if (-not (Test-Path app.exe)) { Write-Error "pkg produced no executable (does package.json have a bin field?)"; exit 1 }'
        },
        { run: 'Compress-Archive -Path app.exe -DestinationPath release.zip' }
      ];
    }

    // Python — PyInstaller (Windows runner, PowerShell commands)
    const entry = detectPythonEntry(files) || 'main.py';
    const icon = detectIcon(files, ['.ico']);
    const dataDirs = detectDataDirs(files);
    const hiddenImports = detectHiddenImports(files);
    const pythonVersion = detectPythonVersion(files) || '3.12';

    const pyinstallerArgs = ['--onefile', '--name', 'app'];
    if (icon) pyinstallerArgs.push(`--icon ${icon}`);
    // Windows uses ';' as the PyInstaller --add-data separator (not ':')
    for (const dir of dataDirs) {
      pyinstallerArgs.push(`--add-data "${dir};${dir}"`);
    }
    for (const imp of hiddenImports) {
      pyinstallerArgs.push(`--hidden-import ${imp}`);
    }
    pyinstallerArgs.push(entry);

    // Build a PowerShell array literal and invoke pyinstaller with it.
    const psArray = pyinstallerArgs
      .map(a => `'${a.replace(/'/g, "''")}'`)
      .join(', ');

    return [
      { uses: 'actions/checkout@v4' },
      {
        uses: 'actions/setup-python@v5',
        with: { 'python-version': `'${pythonVersion}'` }
      },
      {
        name: 'Install dependencies',
        run: 'if (Test-Path requirements.txt) { pip install -r requirements.txt }'
      },
      { run: 'pip install pyinstaller' },
      {
        name: 'Build with PyInstaller',
        run: [
          `$pyinstallerArgs = @(${psArray})`,
          '& pyinstaller @pyinstallerArgs',
          'if (-not (Test-Path dist\\app.exe)) { Write-Error "PyInstaller produced no .exe"; exit 1 }',
          'Compress-Archive -Path dist\\* -DestinationPath release.zip'
        ].join('\n')
      }
    ];
  },

  artifact: {
    glob: 'release.zip',
    isGlob: false,
    artifactName: 'app-windows.zip',
    verifyCommand: 'if (-not (Test-Path release.zip)) { Write-Error "No executable archive produced"; exit 1 }'
  }
};

export default windowsExe;
