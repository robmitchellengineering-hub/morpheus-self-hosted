// macOS App compile target — produces a .app bundle or binary.
// Node: @yao-pkg/pkg. Python: PyInstaller with --windowed for .app bundle.
// Wraps raw binaries in a proper .app bundle with Info.plist.

import {
  isNodeProject, isPythonProject, isSwiftProject, parsePackageJson, detectPythonEntry,
  detectDataDirs, detectHiddenImports, detectIcon, detectNodeVersion,
  detectPythonVersion, detectSwiftExecutableName, detectBuildScript, detectPackageHints,
  cloneFiles, hasFile, hasPattern
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
// Parameterized by the actual .app name so the instructions match what's
// really in the download — the Node/Python paths always name their bundle
// "MorpheusApp", but the Swift path (added 2026-09-04, see the buildSteps()
// comment below) preserves the project's own app name instead, since
// renaming it would break that project's own Info.plist (which declares
// its own CFBundleExecutable). A README that told Rob to run
// `xattr -cr .../MorpheusApp.app` on a download actually named
// `AnyPDF.app` would just be confusing.
function gatekeeperReadme(appName) {
  return [
    `${appName} -- macOS Gatekeeper notice`,
    '='.repeat(appName.length + 24),
    '',
    "This app is NOT signed with a paid Apple Developer certificate, so after",
    "you unzip it, macOS will likely refuse to open it -- often with:",
    '',
    `    "${appName}" is damaged and can't be opened. You should move it`,
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
    `       xattr -cr /path/to/${appName}.app`,
    '',
    '  3. Double-click the app again -- it should now open normally.',
    '',
    'If instead you see a message saying the developer cannot be verified',
    '(rather than "damaged"), you can also go to System Settings -> Privacy',
    '& Security, scroll down, and click "Open Anyway" after your first',
    'attempt to open the app.',
  ].join('\n');
}

export const macApp = {
  id: 'mac-app',
  label: 'macOS App',
  runner: 'macos-latest',

  validate(files) {
    const warnings = [];
    // Check Swift FIRST — a project can ship both a Package.swift (the real
    // app) and a package.json (a documented "convenience wrapper" JS
    // launcher that just execs the built Swift binary). isNodeProject only
    // checks for package.json, so it would wrongly claim a project like
    // that if checked first. See the buildSteps() Swift branch below for
    // why this matters (2026-09-04, Rob's AnyPDF app).
    if (isSwiftProject(files)) {
      if (!hasPattern(files, /\.swift$/)) {
        return {
          valid: false,
          error: 'mac-app (Swift) requires Package.swift plus at least one .swift source file.',
          warnings
        };
      }
      return { valid: true, warnings };
    }
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

    // 2026-09-04 (Rob, on AnyPDF: "AnyPDF executable not found. Please
    // build the app first using `swift build -c release` or run
    // `./build.sh`." when actually running the compiled Mac app): this
    // project is a real native Swift/SwiftUI macOS app (Package.swift +
    // Sources/), but it ALSO ships a package.json + index.js as a
    // documented "convenience wrapper" (its own compile/README.md, Option
    // 3: "npm does not replace SwiftPM; it simply calls the same
    // underlying commands"). Because isNodeProject(files) only checks for
    // package.json's existence, this hybrid project was being routed down
    // the Node/pkg branch below: pkg dutifully wrapped index.js into a
    // binary, but index.js is just a launcher that execs a pre-built Swift
    // binary at a fixed relative path — one that was never built, because
    // `swift build`/`./build.sh` never ran anywhere in the pipeline. The
    // packaged app worked exactly as written: it printed its own "please
    // build the app first" message and exited 1. That's not a bug in
    // index.js, it's a bug in routing this project to the Node path at
    // all. Fix: check for Package.swift first (see validate() above and
    // isSwiftProject in utils.js) and give it a real Swift build path
    // instead of ever considering Node for a project shaped like this.
    if (isSwiftProject(files)) {
      const appName = detectSwiftExecutableName(files) || 'App';
      const hasOwnInfoPlist = hasFile(files, 'Info.plist');
      const steps = [
        { uses: 'actions/checkout@v4' },
        {
          name: 'Build universal Swift binary',
          run: [
            'set -e',
            // --arch arm64 --arch x86_64 is SwiftPM's own supported way to
            // produce a genuine universal Mach-O binary — Apple's build
            // system merges it correctly via a real lipo of two plain
            // compiled binaries. This is NOT the same situation as the
            // pkg/lipo bug elsewhere in this file: a Swift binary has no
            // appended data trailer, so merging two of them is exactly
            // what lipo is designed for.
            'swift build -c release --arch arm64 --arch x86_64'
          ].join('\n')
        },
        {
          name: 'Build .app bundle',
          run: [
            'set -e',
            `APP_NAME="${appName}"`,
            // Single-arch SwiftPM output lands in .build/release/; the
            // multi-arch ("universal") build above lands in
            // .build/apple/Products/Release/ instead — check both rather
            // than assuming one, matching this project's own index.js,
            // which defensively checks multiple candidate paths too.
            'BUILD_BIN=""',
            'for candidate in ".build/apple/Products/Release/$APP_NAME" ".build/release/$APP_NAME"; do',
            '  if [ -f "$candidate" ]; then BUILD_BIN="$candidate"; break; fi',
            'done',
            'test -n "$BUILD_BIN" || { echo "Could not find built Swift binary for $APP_NAME (checked .build/apple/Products/Release and .build/release)"; exit 1; }',
            'mkdir -p "$APP_NAME.app/Contents/MacOS" "$APP_NAME.app/Contents/Resources"',
            'cp "$BUILD_BIN" "$APP_NAME.app/Contents/MacOS/$APP_NAME"',
            'chmod +x "$APP_NAME.app/Contents/MacOS/$APP_NAME"',
            icon ? `cp ${icon} "$APP_NAME.app/Contents/Resources/app.icns"` : '# no icon found',
            // Most Swift Package Manager mac-app projects ship their own
            // Info.plist (this one does) — use it as-is rather than
            // generating a generic one that might not match what the
            // executable target actually expects (bundle id, etc.).
            hasOwnInfoPlist
              ? 'cp Info.plist "$APP_NAME.app/Contents/Info.plist"'
              : [
                  'cat > "$APP_NAME.app/Contents/Info.plist" <<PLIST',
                  '<?xml version="1.0" encoding="UTF-8"?>',
                  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
                  '<plist version="1.0">',
                  '<dict>',
                  '    <key>CFBundleExecutable</key><string>' + appName + '</string>',
                  '    <key>CFBundleIdentifier</key><string>com.morpheus.app</string>',
                  '    <key>CFBundleName</key><string>' + appName + '</string>',
                  '    <key>CFBundleVersion</key><string>1.0.0</string>',
                  '    <key>CFBundlePackageType</key><string>APPL</string>',
                  icon ? '    <key>CFBundleIconFile</key><string>app.icns</string>' : '# no icon',
                  '</dict>',
                  '</plist>',
                  'PLIST'
                ].join('\n'),
            'xattr -cr "$APP_NAME.app"',
            // Same ad-hoc-signing rationale as the Node/Python paths below
            // — see the comment above gatekeeperReadme().
            'codesign --force --deep --sign - "$APP_NAME.app" || echo "codesign failed -- app will still work, just fully unsigned"',
            'cat > README.txt <<GATEKEEPER_README',
            gatekeeperReadme(appName),
            'GATEKEEPER_README',
            'tar -czf app.tar.gz "$APP_NAME.app" README.txt',
            'test -f app.tar.gz || { echo "Failed to create .app bundle"; exit 1; }'
          ].join('\n')
        }
      ];
      return steps;
    }

    if (isNodeProject(files)) {
      // 2026-09-04 (Rob: "SyntaxError: Invalid or unexpected token / at
      // readPrelude (node:internal/bootstrap/pkg:...)" when actually running
      // a compiled Mac app): root cause was THIS step, not Gatekeeper.
      // `lipo -create` is the normal way to merge two Mach-O executables
      // into a universal binary, but a pkg/@yao-pkg/pkg binary isn't a plain
      // Mach-O executable — it's a Mach-O executable with the entire bundled
      // JS application appended as a trailer AFTER the executable segments,
      // located at runtime by searching backward from the end of the
      // currently-running file for a marker. lipo has no idea that trailer
      // exists; it just concatenates the two files under a fat-binary
      // header. The OS picks the correct architecture's Mach-O slice to
      // execute, but that slice's own trailer-search-from-EOF now lands on
      // whatever bytes happen to be at the end of the *combined* fat file
      // (the other architecture's data), so the "JS bundle" it hands to
      // `vm.Script` is garbage — hence the SyntaxError. This is a
      // long-documented, unfixed limitation of pkg's binary format, not
      // something specific to this project (see vercel/pkg#1597 — same
      // "Invalid or unexpected token" in the same `readPrelude` bootstrap
      // step, on the exact same lipo-a-fat-binary setup).
      //
      // Fix: don't lipo pkg binaries together at all. Ship both
      // architecture-specific binaries intact inside the bundle, and make
      // the actual CFBundleExecutable a tiny shell script (plain text is
      // inherently architecture-independent — no lipo needed) that execs
      // whichever one matches `uname -m` at launch time. Each binary keeps
      // its own trailer fully intact since neither is ever byte-merged.
      const nodeVersion = detectNodeVersion(files) || '24';
      const steps = [
        { uses: 'actions/checkout@v4' },
        {
          uses: 'actions/setup-node@v4',
          with: { 'node-version': `'${nodeVersion}'` }
        },
        { run: 'npm install' },
        { run: 'npx @yao-pkg/pkg . --targets node24-macos-x64 --output app-x64' },
        { run: 'npx @yao-pkg/pkg . --targets node24-macos-arm64 --output app-arm64' },
        {
          name: 'Build .app bundle',
          run: [
            'mkdir -p "MorpheusApp.app/Contents/MacOS"',
            'mkdir -p "MorpheusApp.app/Contents/Resources"',
            'cp app-x64 "MorpheusApp.app/Contents/MacOS/MorpheusApp-x64"',
            'cp app-arm64 "MorpheusApp.app/Contents/MacOS/MorpheusApp-arm64"',
            'chmod +x "MorpheusApp.app/Contents/MacOS/MorpheusApp-x64" "MorpheusApp.app/Contents/MacOS/MorpheusApp-arm64"',
            // Single-quoted heredoc delimiter — do NOT let the build
            // runner's shell expand $DIR/$@/uname here; those must stay
            // literal so they evaluate at launch time, on the user's Mac.
            "cat > \"MorpheusApp.app/Contents/MacOS/MorpheusApp\" <<'DISPATCH'",
            '#!/bin/bash',
            'DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
            'if [ "$(uname -m)" = "arm64" ]; then',
            '  exec "$DIR/MorpheusApp-arm64" "$@"',
            'else',
            '  exec "$DIR/MorpheusApp-x64" "$@"',
            'fi',
            'DISPATCH',
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
            // Not a real fix for Gatekeeper (needs a paid Apple Developer
            // cert + notarization for that) — see the comment above
            // gatekeeperReadme() — but an ad-hoc signature gives macOS
            // something to inspect instead of an entirely unsigned binary,
            // which on most macOS versions turns the dead-end "damaged,
            // move to Bin" message into a clickable "Open Anyway" warning.
            // Sign the two real Mach-O binaries individually (best-effort —
            // the dispatcher script isn't a signable code object, so it's
            // left alone) before signing the bundle as a whole.
            'codesign --force --sign - "MorpheusApp.app/Contents/MacOS/MorpheusApp-x64" 2>/dev/null || true',
            'codesign --force --sign - "MorpheusApp.app/Contents/MacOS/MorpheusApp-arm64" 2>/dev/null || true',
            'codesign --force --deep --sign - "MorpheusApp.app" || echo "codesign failed -- app will still work, just fully unsigned"',
            'cat > README.txt <<GATEKEEPER_README',
            gatekeeperReadme('MorpheusApp'),
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
    // utils.js's detectBuildScript. Codesigning below is generic (loops
    // over whatever .app bundle(s) actually landed in dist/) since we don't
    // know what name a project's own script chose; the templated Gatekeeper
    // README (which needs a literal app name baked in) is skipped here —
    // a project that wrote its own build script has typically also written
    // its own docs (see the Wikidata Batch Uploader's own README.md).
    if (buildScript) {
      return [
        ...setupSteps,
        {
          name: "Build with the project's own build script",
          run: [
            `python ${buildScript}`,
            'ls dist/',
            'compgen -G "dist/*" > /dev/null || { echo "Build script produced nothing in dist/"; exit 1; }',
            'for app in dist/*.app; do [ -d "$app" ] && (codesign --force --deep --sign - "$app" || echo "codesign failed for $app -- it will still work, just fully unsigned"); done'
          ].join('\n')
        },
        { run: 'tar -czf app.tar.gz -C dist .' }
      ];
    }

    const args = ['--onefile', '--windowed', '--osx-bundle-id', 'com.morpheus.app', '--name', 'MorpheusApp'];
    if (icon) args.push(`--icon ${icon}`);
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
          'test -d "dist/MorpheusApp.app" || test -f "dist/MorpheusApp" || { echo "PyInstaller produced no output"; exit 1; }',
          // See the comment above gatekeeperReadme() (mac-app.js) — ad-hoc
          // signing isn't real notarization, but it turns macOS's dead-end
          // "damaged, move to Bin" message into a clickable "Open Anyway"
          // warning on most versions. Only applies when --windowed actually
          // produced a .app bundle (a plain onefile binary has nothing to
          // codesign as a bundle, so this is a no-op in that case).
          'test -d "dist/MorpheusApp.app" && (codesign --force --deep --sign - "dist/MorpheusApp.app" || echo "codesign failed -- app will still work, just fully unsigned") || true',
          'cat > dist/README.txt <<GATEKEEPER_README',
          gatekeeperReadme('MorpheusApp'),
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
    /pkg.*failed/i,
    /error:\s/i,
    /Compiling failed/i,
    /Could not find built Swift binary/i
  ],

  // 2026-09-08 (Rob: "need to look at the functionality of the AI docs and
  // be able to feed that into morpheus every construct so the planner has a
  // better idea of how to build"): everything above this point is knowledge
  // this adapter already has about what it will actually do with the
  // project's files at compile time -- accumulated the hard way, from real
  // Rob-reported failures (see the comments on validate()/buildSteps()
  // above: the Node-wrapper-around-a-real-Swift-app misroute, the pkg/lipo
  // fat-binary corruption, the Gatekeeper "damaged" message). None of that
  // ever reached the planner or coder AI -- chatWithMorpheus.js's
  // BUILD_TARGET_INSTRUCTIONS only ever told them "Swift: include Xcode
  // project or Swift Package, document 'swift build' or xcodebuild", so
  // they were writing Swift projects blind to what this adapter actually
  // requires and does. aiNotes is this adapter's own plain-language summary
  // of that, read by chatWithMorpheus.js (see its compileAdapterBlock) and
  // injected into the SAME context block the planner and coder both see, on
  // every construct/edit turn for a mac-app project -- so it can't drift out
  // of sync with the adapter code the way a hand-duplicated copy in the
  // system prompt would.
  aiNotes: `PLATFORM COMPILE PIPELINE NOTES (mac-app target) — this is exactly what Morpheus's own compile pipeline will do with your files; write to it, don't guess:
- Swift projects: ship as a Swift Package — Package.swift at the repo root plus Sources/<ExecutableName>/*.swift. The pipeline reads Package.swift and detects the binary name from ".executableTarget(name: \"...\")" (falls back to the top-level "Package(name: ...)" if there's no executable target) — name it explicitly and keep it consistent everywhere the app refers to its own name.
- Do NOT also add a package.json "convenience wrapper" next to a real Swift project. The pipeline checks for Package.swift FIRST and only uses the Node/pkg path when there's no Package.swift — a wrapper script that execs a "pre-built" Swift binary at a fixed path will find nothing there, since the pipeline never runs that wrapper.
- The pipeline itself runs "swift build -c release --arch arm64 --arch x86_64" (a real universal binary) and copies the result into <AppName>.app/Contents/MacOS/<AppName> for you — do not write your own build.sh, Xcode project, or GitHub Actions workflow for this target.
- If you include your own Info.plist at the repo root, the pipeline uses it AS-IS, unmodified — its CFBundleExecutable must match the executable target name exactly or the .app looks built but fails to launch. When in doubt, omit Info.plist entirely; the pipeline then generates a correct minimal one automatically.
- The app ships fully unsigned (best-effort ad-hoc "codesign --sign -" only — no paid Apple Developer certificate exists here). macOS Gatekeeper will show "is damaged, move to Bin"; a README.txt with the xattr -cr workaround is added to the download automatically. Don't add your own signing steps or claim the app is notarized.
- Node/Python projects get the same .app-bundling treatment (pkg for Node, PyInstaller --windowed for Python) — a working entry point (package.json bin/main, or main.py/app.py) is all that's needed; you don't hand-write the packaging steps.`,
};

export default macApp;
