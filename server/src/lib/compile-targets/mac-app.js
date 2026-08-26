// macOS App compile target — produces a .app bundle or binary.
// Node: @yao-pkg/pkg. Python: PyInstaller with --windowed for .app bundle.
// Wraps raw binaries in a proper .app bundle with Info.plist.

import {
  isNodeProject, isPythonProject, parsePackageJson, detectPythonEntry,
  detectDataDirs, detectHiddenImports, detectIcon, detectNodeVersion,
  detectPythonVersion, cloneFiles
} from './utils.js';

export const macApp = {
  id: 'mac-app',
  label: 'macOS App',
  runner: 'macos-latest',

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
          error: 'mac-app (Python) requires a Python entry point (main.py, app.py).',
          warnings
        };
      }
      return { valid: true, warnings };
    }
    return {
      valid: false,
      error: 'mac-app requires either a package.json (Node) or a Python entry point.',
      warnings
    };
  },

  scaffold(files) {
    return { files: cloneFiles(files), generated: [], warnings: [] };
  },

  buildSteps(files) {
    const icon = detectIcon(files, ['.icns', '.png']);

    if (isNodeProject(files)) {
      // Build universal binary: both x64 and arm64, then lipo them together
      const nodeVersion = detectNodeVersion(files) || '20';
      const steps = [
        { uses: 'actions/checkout@v4' },
        {
          uses: 'actions/setup-node@v4',
          with: { 'node-version': `'${nodeVersion}'` }
        },
        { run: 'npm install' },
        { run: 'npx @yao-pkg/pkg . --targets node20-macos-x64 --output app-x64' },
        { run: 'npx @yao-pkg/pkg . --targets node20-macos-arm64 --output app-arm64' },
        {
          name: 'Create universal binary',
          run: 'lipo -create app-x64 app-arm64 -output app || cp app-x64 app'
        },
        {
          name: 'Build .app bundle',
          run: [
            'mkdir -p "MorpheusApp.app/Contents/MacOS"',
            'mkdir -p "MorpheusApp.app/Contents/Resources"',
            'cp app "MorpheusApp.app/Contents/MacOS/MorpheusApp"',
            'chmod +x "MorpheusApp.app/Contents/MacOS/MorpheusApp"',
            icon ? `cp ${icon} "MorpheusApp.app/Contents/Resources/app.icns"` : '# no icon found',
            'cat > "MorpheusApp.app/Contents/Info.plist" <<PLIST',
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
            '<plist version="1.0">',
            '<dict>',
            '    <key>CFBundleExecutable</key><string>MorpheusApp</string>',
            '    <key>CFBundleIdentifier</key><string>com.morpheus.app</string>',
            '    <key>CFBundleName</key><string>MorpheusApp</string>',
            '    <key>CFBundleVersion</key><string>1.0.0</string>',
            '    <key>CFBundlePackageType</key><string>APPL</string>',
            icon ? '    <key>CFBundleIconFile</key><string>app.icns</string>' : '# no icon',
            '</dict>',
            '</plist>',
            'PLIST',
            'tar -czf app.tar.gz MorpheusApp.app',
            'test -f app.tar.gz || { echo "Failed to create .app bundle"; exit 1; }'
          ].join('\n')
        }
      ];
      return steps;
    }

    // Python — PyInstaller with --windowed for .app bundle
    const entry = detectPythonEntry(files) || 'main.py';
    const dataDirs = detectDataDirs(files);
    const hiddenImports = detectHiddenImports(files);
    const pythonVersion = detectPythonVersion(files) || '3.12';

    const args = ['--onefile', '--windowed', '--osx-bundle-id', 'com.morpheus.app', '--name', 'MorpheusApp'];
    if (icon) args.push(`--icon ${icon}`);
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
        with: { 'python-version': `'${pythonVersion}'` }
      },
      { run: 'pip install -r requirements.txt 2>/dev/null || true' },
      { run: 'pip install pyinstaller' },
      {
        name: 'Build with PyInstaller',
        run: [
          `pyinstaller ${args.join(' ')}`,
          'ls dist/',
          'test -d "dist/MorpheusApp.app" || test -f "dist/MorpheusApp" || { echo "PyInstaller produced no output"; exit 1; }'
        ].join('\n')
      },
      { run: 'tar -czf app.tar.gz -C dist .' }
    ];
  },

  artifact: {
    glob: 'app.tar.gz',
    isGlob: false,
    artifactName: 'app-macos.tar.gz',
    verifyCommand: 'test -f app.tar.gz || { echo "No macOS app archive produced"; exit 1; }'
  },

  errorPatterns: [
    /ModuleNotFoundError/i,
    /ImportError/i,
    /PyInstaller/i,
    /lipo.*failed/i,
    /pkg.*failed/i
  ]
};

export default macApp;
