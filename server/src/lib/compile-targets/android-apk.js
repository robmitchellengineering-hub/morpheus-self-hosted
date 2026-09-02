// Android APK compile target — the most failure-prone target.
// Scaffolds Gradle config (settings.gradle, gradle.properties, Compose compiler,
// proguard, local.properties), then builds a debug APK via Gradle on GitHub Actions.

import { hasFile, hasPattern, cloneFiles, getFile, detectGradleVersion, detectAgpVersion, gradleVersionForAgp, detectAndroidPackageName, hasReleaseSigningConfig } from './utils.js';

// Kotlin ↔ Compose compiler compatibility matrix
const KOTLIN_COMPOSE_MATRIX = [
  { kotlin: '1.9.22', compose: '1.5.8' },
  { kotlin: '1.9.0', compose: '1.5.2' },
  { kotlin: '1.8.20', compose: '1.4.7' },
  { kotlin: '1.8.10', compose: '1.4.2' },
];

// Android VectorDrawable XML only supports <path pathData="..."> (plus <group>/
// <clip-path>) inside a <vector> root — it has no <circle>/<rect>/<ellipse>/<line>
// primitives, unlike SVG. The AI sometimes writes SVG-style shapes into these
// files (most often app icons), which AAPT rejects with errors like "attribute
// android:cx not found" — a resource-linking failure that looks nothing like a
// normal Gradle/Kotlin error, so it's easy for an auto-diagnose pass to miss.
// Defensively rewrite the common cases (circle, rect) into equivalent <path>
// elements at scaffold time so a build never fails on this, regardless of what
// the model generated.
function fixInvalidVectorShapes(files) {
  const warnings = [];
  for (const f of files) {
    if (!/\.xml$/.test(f.path) || !/res\/(drawable|mipmap)/.test(f.path)) continue;
    if (!/<vector[\s>]/.test(f.content)) continue;

    const getAttr = (attrs, name) => {
      const m = attrs.match(new RegExp(`android:${name}\\s*=\\s*"([^"]+)"`));
      return m ? parseFloat(m[1]) : null;
    };
    let changed = false;

    // <circle android:fillColor="#f00" android:cx="54" android:cy="70" android:r="10" />
    const newContent1 = f.content.replace(/<circle\b([^>]*?)\/?>(\s*<\/circle>)?/g, (match, attrs) => {
      const cx = getAttr(attrs, 'cx'), cy = getAttr(attrs, 'cy'), r = getAttr(attrs, 'r');
      if (cx == null || cy == null || r == null) return match; // can't safely convert — leave for the build to report
      changed = true;
      const rest = attrs.replace(/\s*android:(cx|cy|r)\s*=\s*"[^"]*"/g, '').trim();
      const pathData = `M${cx - r},${cy} a${r},${r} 0 1,0 ${r * 2},0 a${r},${r} 0 1,0 ${-(r * 2)},0`;
      return `<path ${rest} android:pathData="${pathData}" />`;
    });
    f.content = newContent1;

    // <rect android:fillColor="#fff" android:x="24" android:y="86" android:width="60" android:height="10" />
    f.content = f.content.replace(/<rect\b([^>]*?)\/?>(\s*<\/rect>)?/g, (match, attrs) => {
      const x = getAttr(attrs, 'x') ?? 0, y = getAttr(attrs, 'y') ?? 0;
      const w = getAttr(attrs, 'width'), h = getAttr(attrs, 'height');
      if (w == null || h == null) return match;
      changed = true;
      const rest = attrs.replace(/\s*android:(x|y|width|height)\s*=\s*"[^"]*"/g, '').trim();
      const pathData = `M${x},${y} h${w} v${h} h${-w} Z`;
      return `<path ${rest} android:pathData="${pathData}" />`;
    });

    if (changed) {
      warnings.push(`${f.path}: rewrote invalid SVG-style <circle>/<rect> shape elements as VectorDrawable <path pathData="..."> — Android's vector format doesn't support raw shape primitives, which was failing the AAPT resource-link step.`);
    }
  }
  return warnings;
}

function detectUsesCompose(files) {
  return files.some(f =>
    f.path.endsWith('.kt') && (
      /@Composable/.test(f.content) ||
      /androidx\.compose/.test(f.content) ||
      /setContent\s*\{/.test(f.content) ||
      /remember\s*\{/.test(f.content) ||
      /mutableStateOf/.test(f.content)
    )
  ) || files.some(f =>
    (f.path === 'app/build.gradle' || f.path === 'app/build.gradle.kts') &&
    /androidx\.compose/.test(f.content)
  );
}

export const androidApk = {
  id: 'android-apk',
  label: 'Android APK',
  runner: 'ubuntu-latest',

  validate(files) {
    const warnings = [];
    const hasManifest = hasPattern(files, /app\/src\/main\/AndroidManifest\.xml$/);
    const hasSource = hasPattern(files, /app\/src\/main\/(java|kotlin)\//);
    if (!hasSource) {
      return {
        valid: false,
        error: 'Android project missing source files under app/src/main/java/ or app/src/main/kotlin/',
        warnings
      };
    }
    if (!hasManifest) {
      warnings.push('AndroidManifest.xml not found — a minimal one will be generated during scaffolding.');
    }
    return { valid: true, warnings };
  },

  scaffold(files) {
    const generated = [];
    const warnings = [];
    const augmented = cloneFiles(files);

    // Fix any SVG-style shape primitives in vector drawables before anything
    // else — see fixInvalidVectorShapes above.
    warnings.push(...fixInvalidVectorShapes(augmented));

    // Inject settings.gradle if missing
    if (!hasFile(augmented, 'settings.gradle') && !hasFile(augmented, 'settings.gradle.kts')) {
      augmented.push({
        path: 'settings.gradle',
        content: [
          'pluginManagement {',
          '    repositories {',
          '        google()',
          '        mavenCentral()',
          '        gradlePluginPortal()',
          '    }',
          '}',
          'dependencyResolutionManagement {',
          '    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)',
          '    repositories {',
          '        google()',
          '        mavenCentral()',
          '    }',
          '}',
          "rootProject.name = 'morpheus-app'",
          "include ':app'"
        ].join('\n') + '\n'
      });
      generated.push('settings.gradle');
    }

    // Inject/merge gradle.properties — always ensure the Kotlin in-process
    // strategy and AndroidX flags are present (fixes IR lowering BackendException)
    const existingProps = getFile(augmented, 'gradle.properties');
    const propsLines = [
      'android.useAndroidX=true',
      'android.enableJetifier=true',
      'android.nonTransitiveRClass=true',
      'org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8',
      'org.gradle.parallel=true',
      'org.gradle.caching=true',
      'kotlin.compiler.execution.strategy=in-process'
    ];
    if (existingProps) {
      const existingKeys = new Set(
        existingProps.content.split('\n')
          .filter(l => l.includes('=') && !l.trim().startsWith('#'))
          .map(l => l.split('=')[0].trim())
      );
      for (const prop of propsLines) {
        const key = prop.split('=')[0];
        if (!existingKeys.has(key)) {
          existingProps.content = existingProps.content.trimEnd() + '\n' + prop;
        }
      }
    } else {
      augmented.push({ path: 'gradle.properties', content: propsLines.join('\n') + '\n' });
      generated.push('gradle.properties');
    }

    // Compose compiler detection + config injection
    const usesCompose = detectUsesCompose(augmented);
    if (usesCompose) {
      warnings.push('Jetpack Compose detected — injecting Compose compiler config.');
      const appBuildGradle = getFile(augmented, 'app/build.gradle') || getFile(augmented, 'app/build.gradle.kts');
      if (appBuildGradle && !/buildFeatures\s*\{[\s\S]*compose\s+true/.test(appBuildGradle.content)) {
        const isKts = appBuildGradle.path.endsWith('.kts');
        const composeBlock = isKts
          ? `    buildFeatures {\n        compose = true\n    }\n    composeOptions {\n        kotlinCompilerExtensionVersion = "1.5.8"\n    }\n`
          : `    buildFeatures {\n        compose true\n    }\n    composeOptions {\n        kotlinCompilerExtensionVersion '1.5.8'\n    }\n`;
        appBuildGradle.content = appBuildGradle.content.replace(
          /android\s*\{([\s\S]*?)\n\}/,
          (match, inner) => `android {${inner}\n${composeBlock}}`
        );
        generated.push('app/build.gradle (compose config)');
      }

      // Ensure root build.gradle uses Kotlin 1.9.22+ for Compose compiler 1.5.8.
      // Handles both the plugins DSL style and the legacy buildscript classpath
      // style, and bumps any Kotlin 1.x version below 1.9.22 (including 1.9.0,
      // which is too old for Compose compiler 1.5.8).
      const rootBuildGradle = getFile(augmented, 'build.gradle') || getFile(augmented, 'build.gradle.kts');
      if (rootBuildGradle) {
        // Plugins DSL: id 'org.jetbrains.kotlin.android' version '1.9.0' apply false
        const pluginsRegex = /org\.jetbrains\.kotlin\.android['"]\s+version\s+['"]1\.[0-9]+\.[0-9]+['"]/g;
        if (pluginsRegex.test(rootBuildGradle.content)) {
          rootBuildGradle.content = rootBuildGradle.content.replace(
            /org\.jetbrains\.kotlin\.android['"]\s+version\s+['"]1\.[0-9]+\.[0-9]+['"]/g,
            "org.jetbrains.kotlin.android' version '1.9.22'"
          );
          generated.push('build.gradle (kotlin 1.9.22 for compose)');
        }
        // Buildscript classpath: classpath 'org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.0'
        const classpathRegex = /org\.jetbrains\.kotlin:kotlin-gradle-plugin:1\.[0-9]+\.[0-9]+/g;
        if (classpathRegex.test(rootBuildGradle.content)) {
          rootBuildGradle.content = rootBuildGradle.content.replace(
            /org\.jetbrains\.kotlin:kotlin-gradle-plugin:1\.[0-9]+\.[0-9]+/g,
            'org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.22'
          );
          generated.push('build.gradle (kotlin 1.9.22 for compose)');
        }
      }
    }

    // Inject a minimal AndroidManifest.xml if missing (4.4 — Manifest Injection)
    if (!hasPattern(augmented, /app\/src\/main\/AndroidManifest\.xml$/)) {
      const pkg = detectAndroidPackageName(augmented);
      // Find the main activity class name from source files
      const mainActivity = augmented.find(f =>
        /app\/src\/main\/(java|kotlin)\//.test(f.path) &&
        /class\s+\w*Activity/.test(f.content)
      );
      const activityName = mainActivity
        ? (mainActivity.path.split('/').pop() || 'MainActivity').replace(/\.(kt|java)$/, '')
        : 'MainActivity';
      augmented.push({
        path: 'app/src/main/AndroidManifest.xml',
        content: [
          '<?xml version="1.0" encoding="utf-8"?>',
          `<manifest xmlns:android="http://schemas.android.com/apk/res/android"`,
          `    package="${pkg}">`,
          `    <application`,
          `        android:label="Morpheus App"`,
          `        android:allowBackup="true"`,
          `        android:icon="@mipmap/ic_launcher">`,
          `        <activity`,
          `            android:name=".${activityName}"`,
          `            android:exported="true">`,
          `            <intent-filter>`,
          `                <action android:name="android.intent.action.MAIN" />`,
          `                <category android:name="android.intent.category.LAUNCHER" />`,
          `            </intent-filter>`,
          `        </activity>`,
          `    </application>`,
          `</manifest>`
        ].join('\n') + '\n'
      });
      generated.push('app/src/main/AndroidManifest.xml');
    }

    // Inject empty proguard rules if missing (Gradle references this)
    if (!hasFile(augmented, 'app/proguard-rules.pro')) {
      augmented.push({
        path: 'app/proguard-rules.pro',
        content: '# Add project specific ProGuard rules here.\n'
      });
      generated.push('app/proguard-rules.pro');
    }

    // Inject local.properties (GitHub Actions sets ANDROID_HOME via setup-android)
    if (!hasFile(augmented, 'local.properties')) {
      augmented.push({
        path: 'local.properties',
        content: 'sdk.dir=/usr/local/lib/android/sdk\n'
      });
      generated.push('local.properties');
    }

    return { files: augmented, generated, warnings };
  },

  buildSteps(files) {
    // 4.3 — Auto-detect Gradle version from wrapper properties. If the project
    // has no wrapper, or the detected version is older than 8.0, fall back to
    // a Gradle version that's compatible with the project's AGP version — not
    // a hardcoded 8.5. Using Gradle 8.5 with AGP 8.1.0 (a common combo) fails
    // with ClassNotFoundException because AGP 8.1.0 was built for Gradle 8.0.
    const detected = detectGradleVersion(files);
    const agpVersion = detectAgpVersion(files);
    const agpCompatibleGradle = gradleVersionForAgp(agpVersion);
    let gradleVersion;
    if (detected && parseInt(detected.split('.')[0], 10) >= 8) {
      // Use the wrapper's version, but sanity-check it against the AGP version.
      // If the wrapper version is NEWER than what the AGP supports, use the
      // AGP-compatible version instead to avoid internal API mismatches.
      const detectedMinor = parseInt(detected.split('.')[1] || '0', 10);
      const agpMaxMinor = agpVersion ? parseInt(agpVersion.split('.')[1] || '0', 10) : 99;
      // AGP 8.x supports Gradle up to roughly 8.(x+1) — if the wrapper is way
      // ahead of the AGP, clamp down to the AGP-compatible version.
      if (agpVersion && detectedMinor > agpMaxMinor + 2) {
        gradleVersion = agpCompatibleGradle;
      } else {
        gradleVersion = detected;
      }
    } else {
      gradleVersion = agpCompatibleGradle;
    }

    // 4.5 — Build Variants: if the project defines a release signing config,
    // build assembleRelease; otherwise fall back to assembleDebug
    const useRelease = hasReleaseSigningConfig(files);
    const assembleTask = useRelease ? 'assembleRelease' : 'assembleDebug';

    return [
      { uses: 'actions/checkout@v4' },
      {
        uses: 'actions/setup-java@v4',
        with: { 'java-version': "'17'", distribution: "'temurin'" }
      },
      { uses: 'android-actions/setup-android@v3' },
      {
        name: 'Cache Gradle',
        uses: 'actions/cache@v4',
        with: {
          path: "~/.gradle/caches\n~/.gradle/wrapper",
          key: "gradle-${{ runner.os }}-${{ hashFiles('**/*.gradle*', '**/gradle.properties') }}",
          'restore-keys': 'gradle-${{ runner.os }}-'
        }
      },
      {
        name: `Install Gradle ${gradleVersion}`,
        run: [
          `wget -q https://services.gradle.org/distributions/gradle-${gradleVersion}-bin.zip -O /tmp/gradle.zip`,
          'unzip -q /tmp/gradle.zip -d /tmp',
          `echo "/tmp/gradle-${gradleVersion}/bin" >> $GITHUB_PATH`
        ].join('\n')
      },
      {
        name: 'Generate Gradle wrapper',
        run: [
          'rm -rf gradlew gradle',
          `gradle wrapper --gradle-version ${gradleVersion}`
        ].join('\n')
      },
      { run: 'chmod +x gradlew' },
      {
        name: `Assemble ${useRelease ? 'release' : 'debug'} APK`,
        run: `./gradlew ${assembleTask} --no-daemon -Pkotlin.compiler.execution.strategy=in-process`
      },
      {
        name: 'Locate APK',
        run: [
          'find app/build/outputs/apk -name "*.apk" -exec cp {} release.apk \\; 2>/dev/null || find . -name "*.apk" -exec cp {} release.apk \\; 2>/dev/null',
          'test -f release.apk || { echo "Gradle produced no APK"; exit 1; }',
          'ls -la release.apk'
        ].join('\n')
      }
    ];
  },

  artifact: {
    glob: 'release.apk',
    isGlob: false,
    artifactName: 'app.apk',
    verifyCommand: 'test -f release.apk || { echo "No APK produced"; exit 1; }'
  },

  errorPatterns: [
    /FAILURE: Build failed/i,
    /BackendException/i,
    /IR lowering/i,
    /Could not resolve/i,
    /Compilation error/i
  ]
};

export default androidApk;
