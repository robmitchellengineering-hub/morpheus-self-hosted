// iOS App compile target — builds and archives an iOS app.
// Supports Xcode projects (.xcodeproj) and Swift Packages (Package.swift).
// Handles CocoaPods, Swift Package resolution, scheme detection, and .ipa export.

import { CompileTarget, ProjectFile, BuildStep } from './types.ts';
import { hasFile, hasPattern, cloneFiles } from './utils.ts';

export const iosApp: CompileTarget = {
  id: 'ios-app',
  label: 'iOS App',
  runner: 'macos-latest',

  validate(files: ProjectFile[]) {
    const warnings: string[] = [];
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

  scaffold(files: ProjectFile[]) {
    return { files: cloneFiles(files), generated: [], warnings: [] };
  },

  buildSteps(files: ProjectFile[]): BuildStep[] {
    const isSwiftPackage = hasFile(files, 'Package.swift');
    const hasPodfile = hasFile(files, 'Podfile');

    if (isSwiftPackage) {
      const steps: BuildStep[] = [
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
    const steps: BuildStep[] = [
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

    steps.push({
      name: 'Resolve Xcode project',
      run: [
        'PROJECT=$(find . -name "*.xcodeproj" -maxdepth 3 | head -1)',
        'if [ -z "$PROJECT" ]; then echo "No .xcodeproj found"; exit 1; fi',
        'SCHEME=$(xcodebuild -list -project "$PROJECT" 2>/dev/null | grep -A1 "Schemes:" | tail -1 | xargs)',
        'if [ -z "$SCHEME" ]; then SCHEME=$(basename "$PROJECT" .xcodeproj); fi',
        'echo "PROJECT=$PROJECT" >> $GITHUB_ENV',
        'echo "SCHEME=$SCHEME" >> $GITHUB_ENV'
      ].join('\n')
    });

    steps.push({
      name: 'Archive and export',
      run: [
        'mkdir -p build',
        'xcodebuild archive -project "$PROJECT" -scheme "$SCHEME" -configuration Release -archivePath build/app.xcarchive -destination "generic/platform=iOS" CODE_SIGNING_ALLOWED=NO || { echo "xcodebuild archive failed"; exit 1; }',
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
  ]
};

export default iosApp;