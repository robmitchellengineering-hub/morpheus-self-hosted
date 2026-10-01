// macOS App compile target — produces a mountable .dmg disk image
// containing the app bundle (or binary) plus a Gatekeeper README.
// Node: @yao-pkg/pkg. Python: PyInstaller with --windowed for .app bundle.
// Wraps raw binaries in a proper .app bundle with Info.plist.

import {
  isNodeProject, isPythonProject, isSwiftProject, parsePackageJson, detectPythonEntry,
  detectDataDirs, detectHiddenImports, detectIcon, detectNodeVersion,
  detectPythonVersion, detectSwiftExecutableName, detectBuildScript, detectPackageHints,
  detectRequirementsFile, requirementsFileIncludesPyinstaller,
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
    "you drag it out of this disk image, macOS will likely refuse to open it --",
    "often with:",
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

// 2026-09-16 (Rob: asked to switch the Wikidata Batch Uploader from
// windows-exe to mac-app, remembered a .dmg coming out of this target
// before -- it never actually did. saveCompiledArtifacts.js has carried a
// '.dmg': 'application/x-apple-diskimage' content-type entry since the very
// first self-hosted commit, but nothing ever produced one; every branch
// below just tar'd the .app bundle into app.tar.gz). A real .dmg is the
// standard way indie/unsigned Mac apps get distributed -- Finder mounts it,
// the user drags the .app onto the bundled Applications shortcut, then
// ejects -- so build one for real instead. `hdiutil` is preinstalled on
// every macos-latest runner (no new dependency). Only adds the Applications
// shortcut when the staging dir actually contains a .app bundle (a raw
// binary, from a project's own non-.app build script, has nothing sensible
// to drag there).
function dmgBuildStep(stagingDir, volname, dmgName) {
  const dmg = dmgName || 'app.dmg';
  return [
    `if compgen -G "${stagingDir}/*.app" > /dev/null; then ln -s /Applications "${stagingDir}/Applications"; fi`,
    `hdiutil create -volname "${volname}" -srcfolder "${stagingDir}" -ov -format UDZO ${dmg}`,
    `test -f ${dmg} || { echo "Failed to create .dmg"; exit 1; }`
  ].join('\n');
}

// Stage the things the download should actually contain.
//
// 2026-10-01 (Rob mounted the compiled Wikidata Uploader and found three items in it, one of which was
// another disk image): the build-script branch used to do `cp -R dist/. dmg_staging/`, so whatever the
// project's own build script happened to leave in dist/ was copied verbatim into ours. That project's
// build.py writes a .dmg of its own — the result was a 103 MB disk image nested inside a 301 MB one,
// next to the raw --onedir folder that is already inside the .app. Nobody wants a disk image inside a
// disk image, so: when dist/ holds .app bundles, stage exactly those (everything else PyInstaller made
// is already inside them) plus the README; otherwise stage dist/ minus any archive.
function stageDist(stagingDir) {
  return [
    `mkdir -p ${stagingDir}`,
    'if compgen -G "dist/*.app" > /dev/null; then',
    `  cp -R dist/*.app ${stagingDir}/`,
    `  if [ -f dist/README.txt ]; then cp dist/README.txt ${stagingDir}/; fi`,
    'else',
    `  rsync -a --exclude '*.dmg' --exclude '*.zip' dist/ ${stagingDir}/`,
    'fi'
  ].join('\n');
}

// WHICH MACS A BUILD RUNS ON IS DECIDED BY THE RUNNER, NOT BY THE PROJECT — and for Python it takes two.
//
// 2026-10-01 (Rob: "This app is not suported on this mac" — holding a DMG Morpheus had just built him):
// PyInstaller compiles for the machine it runs on, and every runner this target used was macos-latest
// (Apple Silicon), so every Python/Qt app came out arm64-only and an Intel Mac refused it. There was no
// Intel download to ask for and nothing in the filename to say so; the previous fix only reported the
// architecture after the fact. The Swift path genuinely cross-builds (`swift build --arch arm64 --arch
// x86_64`) and the Node path ships both binaries behind a `uname -m` dispatcher, so both of those are
// one-runner jobs. Python is not cross-buildable, so it gets one job per architecture and the release
// carries both disk images, each named for the Mac it opens on — the filename is the only place a person
// browsing a release or a downloads folder actually looks.
export function macAppRunners(files) {
  if (isSwiftProject(files) || isNodeProject(files)) {
    return [{ runner: 'macos-latest', arch: 'universal' }];
  }
  return [
    { runner: 'macos-15-intel', arch: 'intel' },
    { runner: 'macos-latest', arch: 'apple-silicon' }
  ];
}

// Expanded by GitHub per matrix leg before the shell ever sees it.
const ARCH_DMG = 'app-macos-${{ matrix.arch }}.dmg';

export const macApp = {
  id: 'mac-app',
  label: 'macOS App',
  runner: 'macos-latest',
  // Optional per-target hook: a list of runners turns the job into a build matrix. Only this target needs
  // it, and only for the Python path — see macAppRunners() above. compileProject prefers this over
  // `runner` when it is present.
  runners: macAppRunners,

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
            'mkdir -p dmg_staging',
            'cp -R "$APP_NAME.app" dmg_staging/',
            'cat > dmg_staging/README.txt <<GATEKEEPER_README',
            gatekeeperReadme(appName),
            'GATEKEEPER_README',
            dmgBuildStep('dmg_staging', '$APP_NAME', ARCH_DMG)
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
            'mkdir -p dmg_staging',
            'cp -R MorpheusApp.app dmg_staging/',
            'cat > dmg_staging/README.txt <<GATEKEEPER_README',
            gatekeeperReadme('MorpheusApp'),
            'GATEKEEPER_README',
            dmgBuildStep('dmg_staging', 'MorpheusApp', ARCH_DMG)
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
    const requirementsFile = detectRequirementsFile(files);
    const pyinstallerAlreadyPinned = requirementsFileIncludesPyinstaller(files, requirementsFile);

    const setupSteps = [
      { uses: 'actions/checkout@v4' },
      {
        uses: 'actions/setup-python@v5',
        with: { 'python-version': `'${pythonVersion}'` }
      },
      { run: requirementsFile ? `pip install -r ${requirementsFile}` : 'true' },
      // Skip only when the requirements file itself already pins
      // pyinstaller — see requirementsFileIncludesPyinstaller in utils.js.
      ...(pyinstallerAlreadyPinned ? [] : [{ run: 'pip install pyinstaller' }]),
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
            'for app in dist/*.app; do [ -d "$app" ] && (codesign --force --deep --sign - "$app" || echo "codesign failed for $app -- it will still work, just fully unsigned"); done',
            // Volume name: the first .app's own name if the script produced
            // one, else a generic fallback -- we don't know a raw binary's
            // preferred display name the way we do MorpheusApp above. Stays
            // in this same step (not $GITHUB_ENV) since dmgBuildStep runs
            // right below in the same run block, not a separate step.
            'VOLNAME=$(basename "$(ls -d dist/*.app 2>/dev/null | head -1)" .app 2>/dev/null)',
            'VOLNAME="${VOLNAME:-App}"',
            // Say which Mac this image is for, inside the image — see
            // macAppRunners() above. A project's own build script has
            // typically already written a README into dist/, so this is
            // appended, not overwritten (stageDist copies it across).
            'APP_BIN=$(ls -d dist/*.app/Contents/MacOS/* 2>/dev/null | head -1)',
            'ARCHS=$(lipo -archs "$APP_BIN" 2>/dev/null || echo unknown)',
            'echo "Mach-O architectures produced: $ARCHS (runner: $(uname -m), matrix leg: ${{ matrix.arch }})"',
            stageDist('dmg_staging'),
            'if [ ! -f dmg_staging/README.txt ]; then cat > dmg_staging/README.txt <<GATEKEEPER_README\n' + gatekeeperReadme('the app') + '\nGATEKEEPER_README\nfi',
            'printf "\\nThis build was compiled for: %s (%s)\\n" "${{ matrix.arch }}" "$ARCHS" >> dmg_staging/README.txt',
            dmgBuildStep('dmg_staging', '$VOLNAME', ARCH_DMG)
          ].join('\n')
        }
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
          // SAY WHICH MACS THIS RUNS ON, because the user cannot find out any other way — see
          // macAppRunners() above for why this path needs one runner per architecture and the other two
          // paths need only one. The report is the receipt: it proves which leg produced which image, and
          // it is copied into the download so the person who hits "not supported on this Mac" can read why.
          'APP_BIN="dist/MorpheusApp.app/Contents/MacOS/MorpheusApp"; [ -f "$APP_BIN" ] || APP_BIN="dist/MorpheusApp"',
          'ARCHS=$(lipo -archs "$APP_BIN" 2>/dev/null || echo unknown)',
          'echo "Mach-O architectures produced: $ARCHS (runner: $(uname -m), matrix leg: ${{ matrix.arch }})"',
          // See the comment above gatekeeperReadme() (mac-app.js) — ad-hoc
          // signing isn't real notarization, but it turns macOS's dead-end
          // "damaged, move to Bin" message into a clickable "Open Anyway"
          // warning on most versions. Only applies when --windowed actually
          // produced a .app bundle (a plain onefile binary has nothing to
          // codesign as a bundle, so this is a no-op in that case).
          'test -d "dist/MorpheusApp.app" && (codesign --force --deep --sign - "dist/MorpheusApp.app" || echo "codesign failed -- app will still work, just fully unsigned") || true',
          'cat > dist/README.txt <<GATEKEEPER_README',
          gatekeeperReadme('MorpheusApp'),
          'GATEKEEPER_README',
          // AFTER the heredoc terminator — inside it these lines would be written into the README as
          // literal text instead of running.
          'printf "\\nThis build was compiled for: %s (%s)\\n" "${{ matrix.arch }}" "$ARCHS" >> dist/README.txt',
          stageDist('dmg_staging'),
          dmgBuildStep('dmg_staging', 'MorpheusApp', ARCH_DMG)
        ].join('\n')
      }
    ];
  },

  artifact: {
    // The filename carries the architecture, because that is the only thing a user can see when they are
    // choosing between two downloads — see macAppRunners() above. `${{ matrix.arch }}` is expanded per
    // matrix leg by the release step, so a Python project publishes app-macos-intel.dmg AND
    // app-macos-apple-silicon.dmg in one release, while Swift and Node publish one app-macos-universal.dmg.
    // `artifactName` is deliberately gone: saveCompiledArtifacts renames the FIRST asset to it, which would
    // have thrown the architecture away on exactly the download that has to keep it.
    glob: ARCH_DMG,
    isGlob: false,
    verifyCommand: `test -f ${ARCH_DMG} || { echo "No macOS .dmg produced"; exit 1; }`
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
- Swift projects: ship as a Swift Package — Package.swift at the repo root plus Sources/<ExecutableName>/*.swift. The pipeline reads Package.swift and detects the binary name from ".executableTarget(name: "...")" (falls back to the top-level "Package(name: ...)" if there's no executable target) — name it explicitly and keep it consistent everywhere the app refers to its own name.
- Do NOT also add a package.json "convenience wrapper" next to a real Swift project. The pipeline checks for Package.swift FIRST and only uses the Node/pkg path when there's no Package.swift — a wrapper script that execs a "pre-built" Swift binary at a fixed path will find nothing there, since the pipeline never runs that wrapper.
- The pipeline itself runs "swift build -c release --arch arm64 --arch x86_64" (a real universal binary) and copies the result into <AppName>.app/Contents/MacOS/<AppName> for you — do not write your own build.sh, Xcode project, or GitHub Actions workflow for this target.
- If you include your own Info.plist at the repo root, the pipeline uses it AS-IS, unmodified — its CFBundleExecutable must match the executable target name exactly or the .app looks built but fails to launch. When in doubt, omit Info.plist entirely; the pipeline then generates a correct minimal one automatically.
- The app ships fully unsigned (best-effort ad-hoc "codesign --sign -" only — no paid Apple Developer certificate exists here). macOS Gatekeeper will show "is damaged, move to Bin"; a README.txt with the xattr -cr workaround is added to the download automatically. Don't add your own signing steps or claim the app is notarized.
- Node/Python projects get the same .app-bundling treatment (pkg for Node, PyInstaller --windowed for Python) — a working entry point (package.json bin/main, or main.py/app.py) is all that's needed; you don't hand-write the packaging steps.`,
};

export default macApp;
