# Morpheus — Compile Pipeline Rebuild Plan

> Status: **DRAFT — under refinement**
> Created: 2026-08-22
> Context: The Android APK compile saga (IR lowering errors, missing Compose config, Kotlin version mismatches, missing settings.gradle) exposed that the current compile pipeline is a monolithic structure that we keep patching reactively. This document is the plan to rebuild it properly — for ALL targets, not just Android.

---

## 1. THE PROBLEM

### Current Architecture (what's broken)

The compile pipeline lives in two monolithic files:

**`base44/shared/compileScaffolding.ts`** (370 lines)
- One giant `switch` statement in `scaffoldForCompile()`
- Per-target validation + config injection all inline
- Android scaffolding alone is 140+ lines with Compose detection, gradle.properties merging, Kotlin version patching

**`base44/shared/compileWorkflows.ts`** (275 lines)
- One giant `if/else if` chain in `generateBuildWorkflow()`
- GitHub Actions YAML built via string concatenation (`stepLines.push(...)`)
- No structural validation of generated YAML
- Escaping bugs waiting to happen

### Symptoms

1. **Reactive patching** — Every Android issue was a bolt-on fix to a shared file. Fixing Compose config meant editing the same function that handles Python, iOS, and Arduino.
2. **Cross-target risk** — A change to fix Android's Gradle setup could break another target's workflow generation. No isolation.
3. **Untestable** — Can't unit-test "Android scaffolding" in isolation. Have to test the whole monolithic function.
4. **String-concatenated YAML** — No schema validation. A missing quote or wrong indentation silently produces a broken workflow.
5. **Hard to extend** — Adding a new target means editing two shared monoliths. The recent iOS, RPi, and Arduino additions each required careful insertion into the if/else chain.
6. **Opaque errors** — Validation errors are generic. Each target knows what it needs but can't return targeted messages because the logic is centralized.

### Root Cause

There's no abstraction for "a compile target." Every target's validation, scaffolding, and workflow generation are intertwined in shared functions. There's no contract that says "an Android compile target is responsible for X, Y, Z."

---

## 2. THE PLAN: Per-Target Adapter Modules

### Core Idea

**One self-contained module per compile target**, each exporting the same interface. A registry maps target IDs to adapters. `compileProject` becomes a thin orchestrator that looks up the adapter and delegates.

### Directory Structure

```
base44/shared/compile-targets/
  types.ts              ← CompileTarget interface + shared types
  index.ts              ← registry: target ID → adapter
  android-apk.ts        ← Android adapter
  web-app.ts            ← Web app adapter
  python-package.ts     ← Python package adapter
  windows-exe.ts        ← Windows exe adapter (Node or Python)
  linux-binary.ts       ← Linux binary adapter (Node or Python)
  mac-app.ts            ← macOS app adapter (Node or Python)
  ios-app.ts            ← iOS adapter (Xcode or Swift Package)
  rpi-distro.ts         ← Raspberry Pi distro adapter
  arduino-firmware.ts   ← Arduino firmware adapter
  workflow-renderer.ts  ← Shared: turns BuildStep[] into GitHub Actions YAML
```

### The CompileTarget Interface

```typescript
// types.ts

export interface ProjectFile {
  path: string;
  content: string;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;          // present when valid=false
  warnings: string[];      // non-fatal issues
}

export interface ScaffoldResult {
  files: ProjectFile[];    // augmented file list (originals + generated)
  generated: string[];     // paths of auto-generated files
}

export interface BuildStep {
  name?: string;           // step name (shown in GitHub Actions UI)
  uses?: string;           // GitHub action to use (e.g. "actions/checkout@v4")
  with?: Record<string, string>;  // inputs for the action
  run?: string;             // shell commands (multi-line string)
  env?: Record<string, string>;  // step-level env vars
}

export interface ArtifactSpec {
  glob: string;             // what to upload to the release
  isGlob: boolean;          // true = use fail_on_unmatched_files
  verifyCommand?: string;   // shell command to verify artifact exists before release
}

export interface CompileTarget {
  id: string;               // "android-apk", "web-app", etc.
  label: string;            // "Android APK" (for UI display)
  runner: string;           // "ubuntu-latest" or "macos-latest"

  // 1. Validate: does this project have what this target needs?
  validate(files: ProjectFile[]): ValidationResult;

  // 2. Scaffold: auto-generate missing config files
  scaffold(files: ProjectFile[]): ScaffoldResult;

  // 3. Build steps: the GitHub Actions job steps (structured, not string-concat)
  buildSteps(files: ProjectFile[]): BuildStep[];

  // 4. Artifact: what to release and how to verify it
  artifact: ArtifactSpec;

  // 5. Required secrets (e.g. iOS signing, RPi WiFi) — checked before dispatch
  requiredSecrets?: string[];

  // 6. Error patterns for log filtering (what lines are "real errors" for this target)
  errorPatterns?: RegExp[];
}
```

### The Registry

```typescript
// index.ts

import { CompileTarget } from './types';
import androidApk from './android-apk';
import webApp from './web-app';
// ... etc

const registry: Record<string, CompileTarget> = {
  'android-apk': androidApk,
  'web-app': webApp,
  'python-package': pythonPackage,
  'windows-exe': windowsExe,
  'linux-binary': linuxBinary,
  'mac-app': macApp,
  'ios-app': iosApp,
  'rpi-distro': rpiDistro,
  'arduino-firmware': arduinoFirmware,
};

export function getCompileTarget(id: string): CompileTarget | null {
  return registry[id] || null;
}

export function listCompileTargets(): string[] {
  return Object.keys(registry);
}
```

### The Workflow Renderer

```typescript
// workflow-renderer.ts

// Single shared function that turns structured BuildStep[] into valid
// GitHub Actions YAML. No more string concatenation scattered across targets.
export function renderWorkflow(
  runner: string,
  steps: BuildStep[],
  artifact: ArtifactSpec
): string {
  const yamlSteps = steps.map(step => renderStep(step));
  return `name: Build

on:
  workflow_dispatch:

jobs:
  build:
    runs-on: ${runner}
    permissions:
      contents: write
    steps:
${yamlSteps.join('\n')}
      - name: Release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: v\${{ github.run_id }}
          files: ${artifact.glob}
          fail_on_unmatched_files: true
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`;
}
```

### The Slimmed-Down compileProject

```typescript
// compileProject/entry.ts (after refactor)

import { getCompileTarget } from '../../shared/compile-targets';
import { renderWorkflow } from '../../shared/compile-targets/workflow-renderer';

// ... inside the handler:
const adapter = getCompileTarget(target);
if (!adapter) {
  return Response.json({ error: `Unsupported compile target: ${target}` }, { status: 400 });
}

// 1. Validate
const validation = adapter.validate(rawFiles);
if (!validation.valid) {
  return Response.json({ error: validation.error }, { status: 400 });
}

// 2. Scaffold
const { files, generated } = adapter.scaffold(rawFiles);

// 3. Generate workflow from structured steps
const workflow = renderWorkflow(adapter.runner, adapter.buildSteps(files), adapter.artifact);

// 4. Push to GitHub + trigger (unchanged)
```

---

## 3. MIGRATION STRATEGY

### Phase 1: Build the adapter framework (no behavior change)
- Create `compile-targets/types.ts` with the interface
- Create `compile-targets/workflow-renderer.ts`
- Create `compile-targets/index.ts` registry (empty adapters)

### Phase 2: Port each target one at a time
- Port the simplest target first (web-app) to validate the interface
- Port android-apk (the complex one) — this is where we win the most
- Port remaining targets one by one
- Each port: extract logic from the monolith into the adapter, test, verify

### Phase 3: Delete the monoliths
- Once all targets are ported, delete `compileScaffolding.ts` and `compileWorkflows.ts`
- Update `compileProject/entry.ts` to use the new imports

### Phase 4: Add tests
- Each adapter gets a test file with fixture project files
- Test: validate() accepts valid projects, rejects missing files
- Test: scaffold() generates the expected config files
- Test: buildSteps() produces valid structured steps
- Test: renderWorkflow() produces valid YAML

---

## 4. ANDROID-SPECIFIC IMPROVEMENTS (the immediate wins)

The Android adapter is where the most pain was. Beyond the structural refactor, the Android adapter should include:

### 4.1 Smarter Compose Detection
Current: scans for `@Composable` or `androidx.compose` in any `.kt` file.
Improved: also detect `setContent { }`, `remember { }`, `mutableStateOf`, and Compose imports in build.gradle. Log which files triggered Compose mode.

### 4.2 Kotlin Version Matrix
Current: patches Kotlin to 1.9.22 if an old version is detected.
Improved: maintain a Kotlin ↔ Compose compiler compatibility matrix. Auto-select the right Kotlin version for the detected Compose compiler extension version. Fail with a clear error if the combination is incompatible.

### 4.3 Gradle Version Auto-Detection
Current: hardcodes Gradle 8.5.
Improved: detect the Gradle version from `gradle-wrapper.properties` if present. Only inject a known-good version if missing or outdated.

### 4.4 Manifest Injection
Current: fails if AndroidManifest.xml is missing.
Improved: if the project has source files but no manifest, generate a minimal manifest with the package name derived from the project name.

### 4.5 Build Variants
Current: only builds `assembleDebug`.
Improved: detect if the project defines release signing config. If so, build `assembleRelease` instead. Fall back to `assembleDebug`.

---

## 5. PER-TARGET IMPROVEMENT PLANS

The Android section (4) showed the pattern. Below is the same treatment for every other target — current state, what's missing, and what each adapter needs to actually produce a working binary.

### 5.1 Web App (`web-app`)

**Current state:**
- Validates `package.json` exists
- Warns if no `build` script
- Workflow: `npm install` → `npm run build --if-present` → zip `dist/` or `build/` or whole project

**What's missing:**
- **No `index.html` check** — a web app without an HTML entry point is broken, but we don't validate it
- **No framework detection** — React/Vue/Svelte/Angular each need different build handling. We run `npm run build` blindly and hope the framework's build tool is configured
- **No build output directory detection** — we guess `dist/` then `build/` then zip everything. If the framework outputs to `out/`, `public/`, or `.output/`, we miss it
- **No SPA routing fallback** — React Router / Vue Router apps need a catch-all redirect (`_redirects` for Netlify, `vercel.json` rewrites, or a 404.html fallback). Without it, deep links 404 on refresh
- **No static hosting config** — no `vercel.json`, `netlify.toml`, or `_redirects` generation for the output
- **No environment variable handling** — `VITE_`/`NEXT_PUBLIC_`/`VUE_APP_` prefixed env vars aren't validated or injected

**Adapter improvements:**
- Detect framework from `package.json` dependencies (react, vue, svelte, @angular/core, next, etc.)
- Validate `index.html` exists at project root or in `public/`
- Detect build output dir from framework (Vite → `dist/`, Next → `.next/` or `out/`, CRA → `build/`, Nuxt → `.output/public/`)
- Auto-generate `_redirects` file (`/* /index.html 200`) for SPA apps
- Auto-generate `vercel.json` or `netlify.toml` with SPA rewrites if no hosting config exists
- Validate required env vars are set (scan for `process.env.X` / `import.meta.env.X` and warn if missing)

---

### 5.2 Python Package (`python-package`)

**Current state:**
- Auto-generates minimal `pyproject.toml` if missing
- Workflow: `pip install build` → `python -m build` → release `dist/*.whl`

**What's missing:**
- **No `requirements.txt` → `pyproject.toml` conversion** — if the project has `requirements.txt` but no `pyproject.toml`, the auto-generated pyproject doesn't include the dependencies
- **No `__init__.py` validation** — Python packages need `__init__.py` in each package dir. Missing ones cause silent import failures
- **No entry point (console_scripts) detection** — if the app has a `main()` function, we should auto-add `[project.scripts]` to pyproject so the package installs a CLI command
- **No `MANIFEST.in`** — non-Python files (data files, templates, configs) aren't included in the wheel without it
- **No package structure validation** — `pyproject.toml` `[tool.setuptools.packages.find]` needs to find actual packages. If the structure is flat (no `src/` dir), the find config is wrong

**Adapter improvements:**
- If `requirements.txt` exists, parse it and inject dependencies into auto-generated `pyproject.toml`
- Scan for `__init__.py` in expected package directories; warn if missing
- Detect entry point by scanning for `if __name__ == '__main__'` or `def main()` and auto-add `[project.scripts]`
- Auto-generate `MANIFEST.in` including common data file patterns (`*.json`, `*.yaml`, `*.txt`, `templates/`, `static/`)
- Detect package structure (src layout vs flat layout) and configure `[tool.setuptools.packages.find]` correctly

---

### 5.3 Windows EXE (`windows-exe`)

**Current state:**
- Detects Node vs Python
- Node: `@yao-pkg/pkg` → `app.exe`
- Python: `PyInstaller --onefile` → `dist/*.exe` → zip

**What's missing:**
- **No icon support** — Windows executables without icons look unfinished. `.ico` file in project isn't bundled
- **No PyInstaller `.spec` file generation** — complex Python apps with data files, hidden imports, or hooks need a `.spec` file. `--onefile` alone misses these
- **No hidden import detection** — PyInstaller's biggest failure mode. Dynamic imports (plugins, `importlib`, optional dependencies) aren't detected and cause runtime `ModuleNotFoundError`
- **No version info resource** — Windows EXEs can embed version metadata (company, product, version). We don't generate it
- **No native module warning** — `@yao-pkg/pkg` can't bundle native `.node` modules (like `sharp`, `better-sqlite3`). No detection or warning
- **No UPX compression** — PyInstaller supports UPX for smaller binaries. Not configured
- **No `--add-data` for Python** — data files (templates, configs, assets) aren't bundled

**Adapter improvements:**
- Detect `.ico` file in project root; pass to PyInstaller (`--icon=app.ico`) or pkg (`--icon`)
- Generate a PyInstaller `.spec` file with `datas`, `hiddenimports`, and `excludes` based on project analysis
- Scan imports for common hidden-import patterns: `importlib.import_module`, `__import__`, plugin entry points, `pkg_resources` — add to `hiddenimports`
- Generate version info file for PyInstaller (`--version-file=version.txt`)
- Detect native `.node` modules in `package.json` dependencies; warn that pkg can't bundle them and suggest `nexe` or a different approach
- Auto-detect data directories (`templates/`, `static/`, `assets/`, `data/`) and add to PyInstaller `--add-data`
- Enable UPX if available (`--upx-dir`)

---

### 5.4 Linux Binary (`linux-binary`)

**Current state:**
- Same as Windows EXE but targets `node20-linux-x64` or PyInstaller Linux output
- Tarballs the result

**What's missing:**
- **No architecture targeting** — only x64. No arm64 (Raspberry Pi, Apple Silicon under rosetta) or armv7
- **No AppImage option** — a raw binary requires the right glibc version. AppImage bundles the runtime and runs on any distro
- **No static linking for Python** — PyInstaller `--onefile` still depends on system glibc. True static compilation needs `python-static` or Nuitka
- **No desktop entry generation** — Linux desktop apps need a `.desktop` file for app menu integration
- **No `.deb` / `.rpm` packaging** — for proper Linux distribution

**Adapter improvements:**
- Detect target architecture from project settings or default to x64; support `arm64` and `armv7`
- Add AppImage build path: build the binary, then wrap with `appimagetool` to produce a portable `.AppImage`
- Offer Nuitka as an alternative to PyInstaller for true static compilation (`nuitka --onefile --static-libpython`)
- Auto-generate `.desktop` file with app name, icon, and exec path
- Optional: generate `.deb` package using `fpm` for proper distribution

---

### 5.5 macOS App (`mac-app`)

**Current state:**
- `@yao-pkg/pkg` → raw binary → tarball
- PyInstaller → `dist/` → tarball
- Runner: `macos-latest`

**What's missing:**
- **No `.app` bundle structure** — `@yao-pkg/pkg` produces a raw binary, not a `.app` bundle. macOS apps need `App.app/Contents/MacOS/binary`, `Contents/Info.plist`, `Contents/Resources/`
- **No `Info.plist` generation** — required for a proper macOS app. Contains bundle ID, version, display name, icon
- **No icon (`.icns`) support** — macOS apps need `.icns` icons, not `.ico`
- **No universal binary** — Apple Silicon (arm64) and Intel (x86_64) need separate builds or a universal binary. We only build for the runner's architecture
- **No code signing** — unsigned apps trigger Gatekeeper warnings. Not required for development, but needed for distribution
- **No PyInstaller `.app` bundle** — PyInstaller can produce `.app` bundles directly with `--windowed` but we tarball `dist/` instead

**Adapter improvements:**
- After building the raw binary, wrap it in a `.app` bundle: create `Contents/MacOS/`, `Contents/Resources/`, generate `Info.plist`
- Detect `.icns` file in project; copy to `Contents/Resources/app.icns` and reference in `Info.plist`
- Build for both architectures: run the build twice (x86_64 on Intel runner, arm64 on Apple Silicon runner) or use `lipo` to create a universal binary. For pkg: build both `node20-macos-x64` and `node20-macos-arm64`, then `lipo -create`
- Generate `Info.plist` with bundle ID (from project name), version, display name, and icon reference
- For PyInstaller: use `--windowed --osx-bundle-id=com.morpheus.app` to produce a proper `.app` bundle directly
- Optional code signing step (if `MACOS_CERTIFICATE` secret is set): `codesign --deep --force --options runtime`

---

### 5.6 iOS App (`ios-app`)

**Current state:**
- Validates `.xcodeproj` or `Package.swift` exists
- Xcode: auto-detects scheme, archives, attempts export (unsigned)
- Swift Package: `swift build -c release` → tarball
- Runner: `macos-latest`

**What's missing:**
- **No `Info.plist` validation** — iOS apps require `Info.plist` with specific keys (CFBundleIdentifier, UILaunchStoryboardName, UISupportedInterfaceOrientations). Missing keys cause App Store rejection
- **No CocoaPods handling** — if `Podfile` exists, `pod install` must run before `xcodebuild`. We don't check for or run it
- **No Swift Package Manager dependency resolution** — `Package.swift` projects with dependencies need `swift package resolve` before building
- **No asset catalog validation** — `Assets.xcassets` with `AppIcon` set is required. Missing = no app icon
- **No scheme auto-detection fallback** — if `xcodebuild -list` fails to find a scheme, we fall back to the project name. This often doesn't match
- **No signing configuration** — `CODE_SIGNING_ALLOWED=NO` produces an unsigned archive. For development installs, we need at least a development signing config
- **No simulator build option** — for testing without a device, we should offer a simulator build target
- **No `.ipa` packaging** — we produce `app.zip` but iOS distribution expects `.ipa` format

**Adapter improvements:**
- Validate `Info.plist` exists and contains required keys; auto-generate a minimal one if missing
- Detect `Podfile` and add `pod install` step before build
- Add `swift package resolve` step for Swift Package projects with dependencies
- Validate `Assets.xcassets/AppIcon.appiconset` exists; warn if missing
- Improve scheme detection: try `xcodebuild -list`, parse schemes, pick the first; if none, derive from the `.xcodeproj` filename
- Support two build modes: `development` (unsigned, for sideloading) and `distribution` (signed, needs `IOS_CERTIFICATE` + `IOS_PROVISIONING_PROFILE` secrets)
- Package as `.ipa` using `xcodebuild -exportArchive` with proper export options plist
- For Swift Package: use `swift build -c release --arch arm64` for device, or `--arch arm64-apple-ios-simulator` for simulator

---

### 5.7 Raspberry Pi Distro (`rpi-distro`)

**Current state:**
- No validation (always valid)
- Workflow: clones `pi-gen`, creates minimal config, builds in Docker, produces `.img.gz`

**What's missing:**
- **No custom package list** — the user's app needs to be installed on the image. We don't inject it
- **No first-boot script** — the app should auto-start on boot. No `firstboot.sh` or systemd service is generated
- **No WiFi config injection** — headless Pi setups need `wpa_supplicant.conf` pre-configured
- **No SSH key setup** — remote access needs SSH enabled with a public key
- **No app bundling** — the user's Python/Node app isn't copied onto the image
- **pi-gen in Docker is slow and fragile** — 30+ minute builds, Docker-in-Docker issues on GitHub Actions
- **No stage customization** — pi-gen has stages 0-5. We skip 3-5 but don't allow custom stages
- **No image compression verification** — `gzip -k` runs but we don't verify the `.img.gz` is valid

**Adapter improvements:**
- Detect the app's runtime (Python/Node) and add it to the pi-gen package list
- Generate a `firstboot.sh` that installs the app, creates a systemd service, and enables it on boot
- Accept WiFi credentials via GitHub secrets (`PI_WIFI_SSID`, `PI_WIFI_PSK`) and inject `wpa_supplicant.conf`
- Accept SSH public key via secret (`PI_SSH_PUBKEY`) and inject into the image
- Copy the user's app files into the image via a custom pi-gen stage (`stage3/00-install-app/`)
- Add a faster build path: use pre-built base images from Raspberry Pi official downloads, then customize with `cloud-init` or `pi-customizer` instead of building from scratch
- Verify the `.img.gz` with `gzip -t` before releasing
- Generate a `flash.sh` helper script that writes the image to an SD card

---

### 5.8 Arduino Firmware (`arduino-firmware`)

**Current state:**
- Requires `platformio.ini`
- Workflow: `pip install platformio` → `pio run` → collect `firmware.hex` or `firmware.bin`

**What's missing:**
- **No board validation** — `platformio.ini` might reference a board that doesn't exist or isn't installed. No pre-check
- **No library dependency installation** — `platformio.ini` `lib_deps` need to be resolved, but if libraries aren't in the registry, the build fails with opaque errors
- **No raw Arduino CLI support** — some projects use `.ino` files without PlatformIO. We reject them. Should support `arduino-cli` as an alternative
- **No multi-environment support** — `platformio.ini` can define multiple `[env:]` sections for different boards. We only build the default
- **No OTA upload config** — for WiFi-enabled boards (ESP32, ESP8266), OTA upload config isn't generated
- **No board package installation** — ESP8266/ESP32 need board manager URLs configured. Not handled
- **No serial monitor / debug info** — firmware builds produce `.elf` with debug symbols but we don't generate a map file or size report

**Adapter improvements:**
- Parse `platformio.ini`, validate the board exists in the PlatformIO registry, warn if unknown
- Run `pio pkg install` (or `pio lib install`) before build to resolve `lib_deps`
- Support raw Arduino projects: if `.ino` files exist but no `platformio.ini`, auto-generate a `platformio.ini` with detected board (from `#include` hints: ESP32 → `esp32dev`, ESP8266 → `esp12e`, AVR → `uno`)
- Build all `[env:*]` sections, not just the default; collect all firmware artifacts
- For WiFi boards: generate OTA upload config (`upload_protocol = espota`, `upload_flags = --auth=...`)
- Inject board manager URLs for ESP platforms (`http://arduino.esp8266.com/stable/package_esp8266com_index.json`)
- Generate a size report (`pio run --verbose` output) and include it as a build artifact for debugging

---

## 6. CROSS-CUTTING IMPROVEMENTS (apply to all targets)

### 6.1 Dry-Run / Preview Mode
Before triggering the actual build, let the user see:
- What files will be generated (scaffolding preview)
- What the workflow YAML looks like
- What the expected artifact is
This catches misconfigurations before wasting a GitHub Actions run.

### 6.2 Build Cache Strategy
Each adapter should declare its cache configuration (npm, pip, Gradle, PlatformIO) as structured data, not inline YAML. The workflow renderer applies it consistently.

### 6.3 Failure Context Extraction
When a build fails, `getCompileStatus` extracts error logs. Each adapter should declare which log patterns are "real errors" vs noise for its target. Android's Gradle errors look different from Python's traceback, which looks different from Xcode's build failures.

### 6.4 Artifact Naming Convention
Each adapter declares its artifact naming convention (`release.apk`, `app.exe`, `firmware.hex`, `morpheus-os.img.gz`). `saveCompiledArtifacts` uses this to name the file in `_compiled/`.

### 6.5 Required Secrets Declaration
Some targets need secrets (iOS signing, RPi WiFi). Each adapter declares `requiredSecrets: string[]`. `compileProject` checks they exist before dispatching and returns a clear error if missing.

---

## 7. OPEN QUESTIONS (to refine)

1. **Should adapters be able to modify the runner?** Currently the runner is fixed per target. Some targets might need conditional runners (e.g. iOS with Xcode 15 vs 16). → Probably not for v1; keep it simple.

2. **Should we support multi-job workflows?** Current design is single-job. Some targets might benefit from parallel jobs (e.g. build + test). → Defer to v2.

3. **How to handle targets that need secrets?** e.g. iOS code signing needs certificates. → The adapter could declare required secrets; compileProject checks they exist before dispatching. (Added to interface as `requiredSecrets`.)

4. **Should the adapter own the artifact-saving logic too?** Currently `saveCompiledArtifacts` is separate. Could each adapter declare its artifact naming convention. → Worth considering for v2. (Added as cross-cutting improvement 6.4.)

5. **Do we need a "dry run" mode?** Let the user see what files would be generated and what the workflow looks like before triggering the build. → Useful for debugging; could be a quick win. (Added as cross-cutting improvement 6.1.)

6. **Priority order for implementation?** Which targets should we port first? Suggested: web-app (simplest, validates the framework) → android-apk (most pain, most value) → python-package → windows-exe/linux-binary/mac-app (similar, can share logic) → ios-app → arduino-firmware → rpi-distro.

---

## 8. WHAT THIS UNLOCKS

- **Isolation**: Fixing one target only touches its own adapter file. Zero risk to other targets.
- **Testability**: Each adapter unit-tested with fixture files. No more "did I break Python by fixing Android?"
- **Structured YAML**: `BuildStep[]` → `renderWorkflow()`. No more string-concatenated YAML with escaping bugs.
- **Extensibility**: New target = new file + one registry line. No editing shared monoliths.
- **Targeted errors**: Each adapter returns validation errors specific to its target's requirements.
- **Reliability**: Every target gets the same thorough treatment Android got — proper validation, smart scaffolding, structured workflow generation, and clear error messages.
- **Future-proofing**: When we add iOS signing, RPi custom images, or Arduino board variants, each lives in its own adapter.

---

_This is a living document. Refine it as we discuss. When the plan is finalized, implementation follows the migration strategy in Section 3._