// macOS App compile target — produces a .app bundle or binary.
// Node: @yao-pkg/pkg. Python: PyInstaller with --windowed for .app bundle.
// Wraps raw binaries in a proper .app bundle with Info.plist.

import {
  isNodeProject, isPythonProject, parsePackageJson, detectPythonEntry,
  detectDataDirs, detectHiddenImports, detectIcon, detectNodeVersion,
  detectPythonVersion, cloneFiles
} from './utils.js';

// 2026-09-04 (Rob: '"MorpheusApp" is damaged and can't be opened. You
// should move it to the Bin.' right after installing a compiled Mac app):
// this is macOS Gatekeeper, not actual corruption. Every app this target
// produces is completely unsigned — Morpheus has no Apple Developer
// certificate configured (that's a paid, $99/year account with real setup,
// a decision for Rob, not something to silently start doing here) — and
// anything downloaded via a browser gets a com.apple.quarantine flag that
// Gatekeeper refuses outright for a fully unsigned binary, with exactly
// that "is damaged" wording rather than the older "unidentified developer"
// prompt. Two things actually help without a paid cert:
//   1. Ad-hoc codesigning (`codesign --sign -`) during the build. It won't
//      make Gatekeeper trust the app, but it gives the OS a signature to
//      inspect, which on most macOS versions changes the dead-end "damaged,
//      move to Bin" message into "Apple could not verify... open anyway?"
//      in System Settings — still a warning, but one the user can actually
//      click through instead of a dead end.
//   2. Bundling plain instructions in the download itself (most people
//      never see Morpheus's own UI again once they've unzipped a Mac app
//      dropped in their Downloads folder), so the fix is right there next
//      to the .app instead of requiring a trip back to ask what's wrong.
const GATEKEEPER_README = [
  'MorpheusApp -- macOS Gatekeeper notice',
  '========================================',
  '',
  "This app is NOT signed with a paid Apple Developer certificate, so after",
  "you unzip it, macOS will likely refuse to open it -- often with:",
  '',
  '    "MorpheusApp" is damaged and can\'t be opened. You should move it',
  '    to the Bin.',
  '',
  "That does NOT mean the app is actually corrupted. It's macOS Gatekeeper",
  "being strict about anything downloaded from the internet that isn't",
  "signed and notarized by a paid Apple Developer account.",
  '',
  'To open it anyway:',
  '',
  '  1. Open Terminal (Applications -> Utilities -> Terminal).',
  '  2. Run this (adjust the path to wherever you moved the app):',
  '',
  '       xattr -cr /path/to/MorpheusApp.app',
  '',
  '  3. Double-click the app again -- it should now open normally.',
  '',
  'If instead you see a message saying the developer cannot be verified',
  '(rather than "damaged"), you can also go to System Settings -> Privacy',
  '& Security, scroll down, and click "Open Anyway" after your first',
  'attempt to open the app.',
].join('\n');

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
            // Not a real fix for Gatekeeter (needs a paid Apple Developer
            // cert + notarization for that) — see the comment above
            // GATEKEEPER_README — but an ad-hoc signature gives macOS
            // something to inspect instead of an entirely unsigned binary,
            // which on most macOS versions turns the dead-end "damaged,
            // move to Bin" message into a clickable "Open Anyway" warning.
            'codesign --force --deep --sign - "MorpheusApp.app" || echo "codesign failed -- app will still work, just fully unsigned"',
            'cat > README.txt <<GATEKEEPER_README',
            GATEKEEPER_README,
            'GATEKEEPER_README',
            'tar -czf app.tar.gz MorpheusApp.app README.txt',
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
          'test -d "dist/MorpheusApp.app" || test -f "dist/MorpheusApp" || { echo "PyInstaller produced no output"; exit 1; }',
          // See the comment above GATEKEEPER_README (mac-app.js) — ad-hoc
          // signing isn't real notarization, but it turns macOS's dead-end
          // "damaged, move to Bin" message into a clickable "Open Anyway"
          // warning on most versions. Only applies when --windowed actually
          // produced a .app bundle (a plain onefile binary has nothing to
          // codesign as a bundle, so this is a no-op in that case).
          'test -d "dist/MorpheusApp.app" && (codesign --force --deep --sign - "dist/MorpheusApp.app" || echo "codesign failed -- app will still work, just fully unsigned") || true',
          'cat > dist/README.txt <<GATEKEEPER_README',
          GATEKEEPER_README,
          'GATEKEEPER_README'
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
