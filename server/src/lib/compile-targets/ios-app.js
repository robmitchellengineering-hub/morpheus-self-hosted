// iOS App compile target — builds and archives an iOS app.
// Supports Xcode projects (.xcodeproj) and Swift Packages (Package.swift).
// Handles CocoaPods, Swift Package resolution, scheme detection, and .ipa export.

import { hasFile, hasPattern, cloneFiles } from './utils.js';

export const iosApp = {
  id: 'ios-app',
  label: 'iOS App',
  runner: 'macos-latest',

  validate(files) {
    const warnings = [];
    const hasProject = hasPattern(files, /\.(xcodeproj|xcworkspace)$/) ||
      hasPattern(files, /\.pbxproj$/) || hasFile(files, 'Package.swift');
    if (!hasProject) {
      return {
        valid: false,
        error: 'ios-app target requires an Xcode project (.xcodeproj) or Swift Package (Package.swift).',
        warnings
      };
    }
    if (hasFile(files, 'Podfile')) {
      warnings.push('CocoaPods Podfile detected — will run pod install before build.');
    }
    return { valid: true, warnings };
  },

  scaffold(files) {
    return { files: cloneFiles(files), generated: [], warnings: [] };
  },

  buildSteps(files) {
    const isSwiftPackage = hasFile(files, 'Package.swift');
    const hasPodfile = hasFile(files, 'Podfile');

    if (isSwiftPackage) {
      const steps = [
        { uses: 'actions/checkout@v4' },
        {
          name: 'Select Xcode',
          run: 'sudo xcode-select -s /Applications/Xcode.app/Contents/Developer || true'
        },
        { run: 'swift package resolve' },
        {
          name: 'Build with Swift Package Manager',
          run: [
            'swift build -c release --arch arm64',
            'cd .build/release',
            'tar -czf ../../app.tar.gz .',
            'test -f ../../app.tar.gz || { echo "Swift build produced no output"; exit 1; }'
          ].join('\n')
        }
      ];
      return steps;
    }

    // Xcode project
    const steps = [
      { uses: 'actions/checkout@v4' },
      {
        name: 'Select Xcode',
        run: 'sudo xcode-select -s /Applications/Xcode.app/Contents/Developer || true'
      }
    ];

    // CocoaPods
    if (hasPodfile) {
      steps.push({
        name: 'Install CocoaPods',
        run: [
          'gem install cocoapods',
          'pod install --repo-update'
        ].join('\n')
      });
    }

    // CocoaPods integration requires building the .xcworkspace pod install
    // generates (it's what actually aggregates the app's own .xcodeproj with
    // the separate Pods.xcodeproj CocoaPods creates) — building the bare
    // .xcodeproj after pod install is a well-known way to get "no such
    // module 'X'" / linker failures, since the Pods target only exists in
    // the workspace, not the app's own project file. Resolve both and prefer
    // the workspace whenever one exists (pod install always makes one).
    steps.push({
      name: 'Resolve Xcode project',
      run: [
        'PROJECT=$(find . -name "*.xcodeproj" -maxdepth 3 | head -1)',
        'if [ -z "$PROJECT" ]; then echo "No .xcodeproj found"; exit 1; fi',
        'WORKSPACE=$(find . -name "*.xcworkspace" -maxdepth 3 | head -1)',
        'if [ -n "$WORKSPACE" ]; then',
        '  SCHEME=$(xcodebuild -list -workspace "$WORKSPACE" 2>/dev/null | grep -A1 "Schemes:" | tail -1 | xargs)',
        'else',
        '  SCHEME=$(xcodebuild -list -project "$PROJECT" 2>/dev/null | grep -A1 "Schemes:" | tail -1 | xargs)',
        'fi',
        'if [ -z "$SCHEME" ]; then SCHEME=$(basename "$PROJECT" .xcodeproj); fi',
        'echo "PROJECT=$PROJECT" >> $GITHUB_ENV',
        'echo "WORKSPACE=$WORKSPACE" >> $GITHUB_ENV',
        'echo "SCHEME=$SCHEME" >> $GITHUB_ENV'
      ].join('\n')
    });

    steps.push({
      name: 'Archive and export',
      run: [
        'mkdir -p build',
        'if [ -n "$WORKSPACE" ]; then',
        '  xcodebuild archive -workspace "$WORKSPACE" -scheme "$SCHEME" -configuration Release -archivePath build/app.xcarchive -destination "generic/platform=iOS" CODE_SIGNING_ALLOWED=NO || { echo "xcodebuild archive failed"; exit 1; }',
        'else',
        '  xcodebuild archive -project "$PROJECT" -scheme "$SCHEME" -configuration Release -archivePath build/app.xcarchive -destination "generic/platform=iOS" CODE_SIGNING_ALLOWED=NO || { echo "xcodebuild archive failed"; exit 1; }',
        'fi',
        '# Try to export as .ipa; fall back to zipping the .app from the archive',
        'cat > /tmp/exportOptions.plist <<PLIST',
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0"><dict><key>method</key><string>development</string><key>signingStyle</key><string>manual</string></dict></plist>',
        'PLIST',
        'xcodebuild -exportArchive -archivePath build/app.xcarchive -exportPath build/export -exportOptionsPlist /tmp/exportOptions.plist 2>/dev/null || true',
        'if [ -d build/export ]; then',
        '  zip -r app.zip build/export',
        'else',
        '  APP=$(find build/app.xcarchive -name "*.app" -type d | head -1)',
        '  if [ -n "$APP" ]; then zip -r app.zip "$APP"; else echo "No .app found in archive"; exit 1; fi',
        'fi',
        'test -f app.zip || { echo "iOS build produced no output"; exit 1; }'
      ].join('\n')
    });

    return steps;
  },

  artifact: {
    glob: 'app.zip',
    isGlob: false,
    artifactName: 'app-ios.zip',
    verifyCommand: 'test -f app.zip || { echo "No iOS app archive produced"; exit 1; }'
  },

  requiredSecrets: [], // signing is optional for development builds

  errorPatterns: [
    /error:/i,
    /BUILD FAILED/i,
    /xcodebuild.*failed/i,
    /No .*found/i,
    /Code signing/i
  ],

  // 2026-09-08: see mac-app.js's matching aiNotes comment for why this
  // exists — a plain-language summary of what this adapter's buildSteps()
  // above actually does, fed into the planner/coder context (via
  // chatWithMorpheus.js's compileAdapterBlock) on every ios-app construct
  // turn, instead of the generic "Swift with SwiftUI/UIKit" line they'd
  // otherwise be working from blind.
  aiNotes: `PLATFORM COMPILE PIPELINE NOTES (ios-app target) — this is exactly what Morpheus's own compile pipeline will do with your files; write to it, don't guess:
- Ship either an Xcode project (.xcodeproj) or a Swift Package (Package.swift) — the pipeline detects which and builds accordingly. You don't write a GitHub Actions workflow yourself.
- Swift Package path: builds arm64-only release ("swift build -c release --arch arm64") and tars up .build/release as the artifact — this is a development build, not an App Store archive, and doesn't need any signing configuration.
- Xcode project path: runs "xcodebuild archive" with CODE_SIGNING_ALLOWED=NO (unsigned, development), then attempts an .ipa export and falls back to zipping the raw .app from the archive if export fails. Keep code signing settings in the project file absent or automatic — a project that requires a specific team/certificate will fail the archive step, since none is configured here.
- A Podfile is supported (pod install runs automatically before the build, and the archive step automatically builds the resulting .xcworkspace instead of the bare .xcodeproj) but adds real build time and another failure surface — only include one if the project genuinely needs a CocoaPods dependency, not by default.`,
};

export default iosApp;
