# Compile-target workflow audit (read-only, paper)

Repo: `/Users/mac/code/morpheus-self-hosted` @ `7f1f711` ("Fix python-package: a project's own `build.py` shadowed the `build` package (#223)").
Method: read each adapter + `utils.js` in full, built a minimal project each `validate()` accepts, ran `validate → scaffold → buildSteps → renderWorkflow`, and read the exact YAML (archived under `/tmp/audit/out/`). Shell semantics and toolchain facts were checked against the GitHub Actions docs, the `@yao-pkg/pkg` target docs, the pi-gen `build-docker.sh` source, the mkosi man page, and the actual `macos-14-arm64` runner image manifest.

Two failure classes that the repo's own commit message flags as previously-false alarms are confirmed **ABSENT** here after re-checking: **arduino-firmware's verify does match its artifact**, and **rpi-distro's `docker.io` is the correct Ubuntu package name**.

---

## android-apk

**Verdict: WILL FAIL for a common class of AI-generated project; WILL WORK for a textbook Android Studio project (wrapper + launcher icon present).**

- Scaffolds `settings.gradle`, `gradle.properties`, `local.properties`, a manifest and `proguard-rules.pro`, downloads a detected/derived Gradle to `/tmp`, regenerates `gradlew`, then `./gradlew assembleDebug` (or `assembleRelease` if a signing config exists), copies the APK to `release.apk`, verifies and releases it.
- Generated YAML: `/tmp/audit/out/android-apk__android-apk.yml`.

**(a) ARTIFACT/VERIFY MISMATCH — ABSENT.** `artifact.glob = 'release.apk'` (android-apk.js:357), `verifyCommand` tests `release.apk` (:360), and the "Locate APK" step writes `release.apk` in the workspace root (:348-349). All three agree.

**(b) NAME SHADOWING — ABSENT.** `gradlew` is deleted and regenerated (:336-337) so a checked-in wrapper can't shadow the downloaded Gradle; `local.properties`/`gradle.properties` are project data, not executables on `PATH`; no `python -m`/`cd`-based resolution hazard. The `find . -name "*.apk"` fallback (:348) could theoretically pick up a checked-in `.apk`, but a Gradle failure aborts the previous step first, and `test -f release.apk` still gates.

**(c) SILENT SUCCESS — ABSENT.** Every producer has a hard check: `test -f release.apk` (:349) and the verify step. `2>/dev/null` only hides find noise.

**(d) MISSING TOOLCHAIN — PARTIALLY PRESENT (version pairing, not package names).** `wget`/`unzip`/JDK 17 (`setup-java@v4`, :302-304)/Android SDK (`android-actions/setup-android@v3`, :305)/Gradle are all real and installed; `local.properties` points at the real runner SDK path. But the AGP→Gradle mapping is wrong for current AGP:
- `utils.js:363` `default: return '8.7'; // AGP 8.6+ → Gradle 8.7+` — AGP 8.7 needs Gradle 8.9, AGP 8.8 needs 8.10.2, AGP 8.9 needs 8.11.1. Any project on AGP ≥ 8.7 with no usable wrapper gets Gradle 8.7 and fails during configuration.
- `utils.js:367` `return '8.5'` for a major version it doesn't know → any **AGP 9.x** project (current in 2026) gets Gradle 8.5 and cannot configure.
- `utils.js:338` `detectAgpVersion` only reads root `build.gradle[.kts]`; a project that declares AGP only in `app/build.gradle` is seen as "unknown" → Gradle 8.5 (same failure).
- `android-apk.js:285` `if (agpVersion && detectedMinor > agpMaxMinor + 2)` only clamps a wrapper that is too **new**. A wrapper that is too **old** for the AGP (e.g. wrapper 8.0 + AGP 8.9) is used verbatim (`:288`), so the build fails with "Minimum supported Gradle version is 8.11.1".

**(e) PRIVILEGES — ABSENT.** No privileged operations.

**(f) RUNNER MISMATCH — ABSENT.** Ubuntu runner, Linux tools.

**(g) PATH MISMATCH — ABSENT.** Artifact lands in the workspace root; glob matches.

**(h) ORDERING — ABSENT.** `assemble → Locate APK → Verify → Release`.

**Concrete defect 1 (high confidence, project-shape dependent).** The auto-injected manifest hard-codes `android:icon="@mipmap/ic_launcher"` (android-apk.js:230) but the scaffold never creates any `res/mipmap*/ic_launcher` (verified: `has any mipmap/drawable file? false`). AAPT2 link then fails with `resource mipmap/ic_launcher ... not found`, for exactly the manifest-less project this code path exists to rescue.
*Fix:* drop the `android:icon` attribute from the generated manifest (or also generate a placeholder mipmap).

**Concrete defect 2 (high confidence logic, conditional trigger).** Gradle/AGP pairing above — `utils.js:363,367` and `android-apk.js:285`.
*Fix:* extend the table through AGP 9.x and use `max(detected, agpCompatibleGradle)` when the AGP version is known.

**Secondary (UNCERTAIN).** The injected manifest uses the deprecated `package="..."` attribute (:226). AGP 8+ ignores/objects to a namespace supplied this way and the scaffold does not inject `namespace` into `app/build.gradle`; I could not confirm from source alone whether this is a warning or a hard error for every AGP 8.x, so I am not asserting it.

---

## windows-exe

**Verdict: WILL FAIL for Python projects that have an icon, a data directory, or a hidden import; WILL WORK for a plain Python project and for Node projects.**

- Node: `npm install` → `npx @yao-pkg/pkg . --targets node24-win-x64 --output app.exe` → verify → `Compress-Archive` → `release.zip`.
- Python: `pip install -r <reqs>` (+ `pip install pyinstaller` unless pinned) → if the project ships `build.py`, run it; otherwise run PyInstaller with a PowerShell argument array → check `dist/` → `Compress-Archive dist\* release.zip`.
- Generated YAML: `/tmp/audit/out/windows-exe__windows-exe-node.yml`, `...__windows-exe-py.yml`, `...__windows-exe__rich-py.yml`.

**(a) ARTIFACT/VERIFY MISMATCH — ABSENT.** Both branches produce `release.zip`; `glob = 'release.zip'` (:166) and the verify step `Test-Path release.zip` (:169) match.

**(b) NAME SHADOWING — ABSENT.** `python build.py` is run as an explicit path (correct — this is the fix direction of the calibration bug), and `pyinstaller`/`npx` resolve through `PATH`/`Scripts`, not the project directory.

**(c) SILENT SUCCESS — ABSENT.** Each branch checks its output (`Test-Path app.exe` :73; `Get-ChildItem dist` :124/:158) before zipping.

**(d) MISSING TOOLCHAIN — PRESENT (argument construction, not packages).** `setup-python`/`pip`/`pyinstaller`/`npx @yao-pkg/pkg` are all real and installed; `node24-win-x64` is a valid yao-pkg target. See the defect below.

**(e) PRIVILEGES — ABSENT.** (f) **RUNNER MISMATCH — ABSENT** (PowerShell/cmdlets are correct for `windows-latest`). (g) **PATH MISMATCH — ABSENT.** (h) **ORDERING — ABSENT.**

**Concrete defect (high confidence).** In the Python branch the PyInstaller arguments are assembled as whole option strings and then splatted:
```js
if (icon) pyinstallerArgs.push(`--icon ${icon}`);                 // windows-exe.js:132
pyinstallerArgs.push(`--add-data "${dir};${dir}"`);               // :135
pyinstallerArgs.push(`--hidden-import ${imp}`);                   // :138
...
const psArray = pyinstallerArgs.map(a => `'${a.replace(/'/g, "''")}'`).join(', '); // :147-149
`$pyinstallerArgs = @(${psArray})`                                 // :156
`& pyinstaller @pyinstallerArgs`                                   // :157
```
PowerShell array splatting passes **each element as one argument**, so PyInstaller receives the literal tokens `--icon app.ico`, `--add-data "templates;templates"` and `--hidden-import mypkg.sub` as single argv entries. Argparse does not split a token on whitespace, so these are not recognised as options (they become unknown operands / would-be script paths) and PyInstaller exits non-zero. Even if it did split them, the embedded double quotes in `--add-data "…;…"` survive (PowerShell single-quoted strings keep them), so the `;` split yields `"templates` / `templates"`. Rendered evidence:
```
$pyinstallerArgs = @('--onefile', '--name', 'app', '--icon app.ico', '--add-data "templates;templates"', '--hidden-import mypkg.sub', 'main.py')
& pyinstaller @pyinstallerArgs
```
This fires for very common Python layouts: `detectDataDirs` matches `templates?/`, `static/`, `assets?/`, `data/`, `config/`, `resources?/`; `detectHiddenImports` matches `importlib.import_module("X")`, `__import__("X")` and `pkg_resources.iter_entry_points`. Note the mac-app Python path is **not** affected — it joins the same args into a shell string (mac-app.js:398-416) and the shell strips the quotes. The smoke harness never caught this: its `py` fixture ships `build.py`, so windows-exe takes the `buildScript` branch (windows-exe.js:117-129) and never reaches this code.
*Fix:* push flag and value as separate elements — `'--icon', icon`, `'--add-data', \`${dir};${dir}\``, `'--hidden-import', imp`.

---

## rpi-distro

**Verdict: WORKFLOW WILL PASS BUT THE IMAGE IS BROKEN for Python projects (silent); UNCERTAIN for Node projects.**

- Installs Docker/quilt/parted/qemu-user-static/debootstrap, clones the pinned pi-gen commit, writes a `config` (stage0-2), injects a `stage2/01-install-app` stage that archives the repo to `/opt/morpheus-app`, bakes deps + a systemd unit, then `sudo ./build-docker.sh`, compresses `morpheus-os.img.gz`, writes `flash.sh`/`flash-network.sh`/`OS-README.md`, verifies and releases `release/*`.
- Generated YAML: `/tmp/audit/out/rpi-distro__rpi-py.yml`, `...__rpi-node.yml`.

**(a) ARTIFACT/VERIFY MISMATCH — ABSENT.** The package step writes `release/morpheus-os.img.gz`, `release/flash.sh`, `release/flash-network.sh`, `release/OS-README.md` (:371-388); `glob = 'release/*'` (:396) matches them and `verifyCommand` checks exactly `release/morpheus-os.img.gz` + `gzip -t` (:398).

**(b) NAME SHADOWING — ABSENT.** `rm -rf pi-gen` before `git init pi-gen` (:283-284) prevents an AI-authored `pi-gen/` from colliding, and the clone runs in its own step. There is no cross-step `cd` leak (`cd pi-gen` is always step-local, :285/:296/:361) and no `python -m`-style sys.path hazard.

**(c) SILENT SUCCESS — PRESENT.** rpi-distro.js:74 `pip3 install -r requirements.txt 2>&1 || true` and :73 `npm install --production 2>&1 || true` run inside the pi-gen chroot with `set -e` (:70), so a dependency-install failure is swallowed. The image still builds, the release still uploads, and the app only reveals the failure by crash-looping on first boot.

**(d) MISSING TOOLCHAIN — PRESENT for the Python path.** apt package names are real (`docker.io` is correct on Ubuntu; this was the known false alarm). But the bake script installs into the **system** Python with no virtualenv and, on Raspberry Pi OS Bookworm (Debian 12, PEP 668), `pip3 install` fails with `externally-managed-environment`. Combined with `|| true` the app's dependencies are never installed, yet `ExecStart=/usr/bin/python3 /opt/morpheus-app/<entry>` (:83) points at that same system interpreter. The adapter's own `aiNotes` even promise the venv that does not exist: "…or pip install -r requirements.txt **into a venv**" (:416). Compare linux-distro.js:107, which does create one.
*Fix:* `python3 -m venv /opt/morpheus-app/.venv && /opt/morpheus-app/.venv/bin/pip install -r requirements.txt` and point `ExecStart` at `.venv/bin/python` (and drop the `|| true`, or at least log a hard error).

**(e) PRIVILEGES — ABSENT.** pi-gen's `build-docker.sh` (upstream) runs `docker run --privileged` and registers binfmt inside; GitHub-hosted `ubuntu-latest` is a full VM with loop devices and a working Docker daemon, which is the documented/upstream-supported way to run pi-gen.

**(f) RUNNER MISMATCH — ABSENT.** (g) **PATH MISMATCH — ABSENT.** `deploy/*.img` is copied to the workspace root, gzipped there, then copied into `release/` (:365-367, :373-374).

**(h) ORDERING — ABSENT.** Config validation (:354-357) and the late SSH-key stage `99-morpheus-ssh` (:332-353) both run before `Build image`; the lexicographic stage ordering is correct.

**Concrete defect (high confidence).** The PEP 668 venv gap above, rpi-distro.js:74 + :76-83 + :416.

---

## linux-distro

**Verdict: UNCERTAIN.** The workflow shape is coherent and I found no artifact-path defect, but the mkosi build is the least verifiable part of this audit and several toolchain assumptions could not be confirmed from source.

- Installs mkosi from git + mkosi build deps, writes `mkosi.conf` (`Format=disk`, `Bootloader=grub`, `Bootable=yes`) and `mkosi.postinst`, copies the repo into `mkosi.extra/opt/morpheus-app`, runs `sudo mkosi --force`, then packages `release/*`.
- Generated YAML: `/tmp/audit/out/linux-distro__linux-node.yml`, `...__linux-py.yml`.

**(a) ARTIFACT/VERIFY MISMATCH — ABSENT.** `release/morpheus-os.img.gz` is produced (:407, :399) and `glob = 'release/*'` (:427) + `verifyCommand` (:429) match. The image-location loop handles both `mkosi.output/morpheus-os.img` and `./morpheus-os.img` (:395-398).

**(b) NAME SHADOWING — ABSENT.** The repo is copied into `mkosi.extra/` with `--exclude="./mkosi.extra"` etc. (:380), so the app cannot shadow mkosi's own inputs; no cross-step `cd`.

**(c) SILENT SUCCESS — PRESENT.** linux-distro.js:105 `npm install --production … || true` and :108 `.venv/bin/pip install … || true` swallow dependency-install failures; the image still builds and ships. (The unit's `ExecStart` then starts a broken app.)

**(d) MISSING TOOLCHAIN — UNCERTAIN.** Real packages: `debootstrap dnf systemd-container squashfs-tools dosfstools mtools xorriso bubblewrap python3-pip python3-venv` and `pip install --break-system-packages git+…/mkosi.git` are all valid on `ubuntu-latest`; `mkosi --version` (:361) fails fast if the install did not take. Two gaps I could not confirm:
  - For the **Fedora** bases (BASES, :39-40) the adapter deliberately does not add `python3-venv`/`python3-pip` ("Fedora's python3 already includes venv + pip", :86-88). If that is not true, `python3 -m venv /opt/morpheus-app/.venv` (:107) fails under `set -e` and the whole build fails. UNCERTAIN.
  - `Bootloader=grub` with only the **signed** grub packages installed (`grub-efi-amd64-signed` + `grub-efi-amd64-bin`, :35-38) and `ShimBootloader=` left at its default `none` means the comment's "signed grub + shim … Secure Boot" intent is not actually configured; whether mkosi's unsigned `Bootloader=grub` path can locate a usable grub binary in those packages I could not verify. UNCERTAIN.

**(e) PRIVILEGES — UNCERTAIN.** mkosi runs as root on a VM (`sudo mkosi --force`, :390) and modern mkosi builds `Format=disk` without loopback (`RepartOffline=yes` default), so this is probably fine on GitHub-hosted runners; I could not run it, so I am not asserting it.

**(f) RUNNER MISMATCH — ABSENT.** (g) **PATH MISMATCH — ABSENT.** (h) **ORDERING — ABSENT.** Validation (:383-386) runs before the build; the `chown` of root-owned `mkosi.output` (:393) happens before the file is read.

**Concrete defect (high confidence).** The silent `|| true` dependency installs at linux-distro.js:105 and :108 — same class as rpi-distro, and here it is partly masked by the venv being created first.

---

## mac-app

**Verdict: UNCERTAIN.** The Swift and Python paths are internally consistent; the Node path's cross-architecture `pkg` invocation is the open question.

- Swift: `swift build -c release --arch arm64 --arch x86_64`, then hand-builds `<Name>.app` (+ `Info.plist`, ad-hoc `codesign`), stages a DMG with an `/Applications` symlink and a Gatekeeper README.
- Node: two `@yao-pkg/pkg` builds (`node24-macos-x64`, `node24-macos-arm64`) plus a shell dispatcher as `CFBundleExecutable`.
- Python: PyInstaller `--onefile --windowed --name MorpheusApp`, or the project's own `build.py`; then DMG.
- Generated YAML: `/tmp/audit/out/mac-app__mac-swift.yml`, `...__mac-node.yml`, `...__mac-py.yml`.

**(a) ARTIFACT/VERIFY MISMATCH — ABSENT.** `dmgBuildStep` writes `app.dmg` (:87-93); `glob = 'app.dmg'` (:438) and `verifyCommand` (:441) match.

**(b) NAME SHADOWING — ABSENT.** `python build.py` is explicit; `pyinstaller`/`npx`/`swift` resolve via `PATH`.

**(c) SILENT SUCCESS — ABSENT.** The only swallowed failure is `codesign … || echo` (:232, :329, :425), which is intentional and does not hide a missing artifact. I specifically checked the `buildScript` branch's `VOLNAME=$(basename "$(ls -d dist/*.app 2>/dev/null | head -1)" .app 2>/dev/null)` (:387) for the `set -e` trap: GitHub's default `run` shell is `bash -e {0}` **without** `pipefail`, so the pipeline status is `head`'s 0, the assignment succeeds, and the `${VOLNAME:-App}` fallback (:388) works. (Under `shell: bash`, which adds `-o pipefail`, it would abort — worth a defensive `|| true`, but not a defect as written.) This was a false alarm on first reading.

**(d) MISSING TOOLCHAIN — UNCERTAIN (host/target arch).** `swift`, `hdiutil`, `codesign`, `xattr`, `pip`/`pyinstaller`, `npx` are all present on `macos-latest`. But `@yao-pkg/pkg`'s own docs state that in Standard mode the bytecode fabricator must **execute** code for the target arch, and that on macOS you build `x64` on `arm64` only "with Rosetta 2". `macos-latest` is an arm64 image, so `pkg … --targets node24-macos-x64` (mac-app.js:280) depends on Rosetta 2 being present. I could not confirm Rosetta 2 from the runner image manifest I read, so this is UNCERTAIN rather than asserted. The `node24-macos-arm64` build (:281) is same-arch and safe.

**(e) PRIVILEGES — ABSENT.** (f) **RUNNER MISMATCH — ABSENT.** `hdiutil`/`codesign`/`swift` are macOS-only and this is the macOS runner. (g) **PATH MISMATCH — ABSENT.** (h) **ORDERING — ABSENT.** The Python buildScript branch writes `dist/README.txt` *before* copying `dist/.` into the staging dir (:426-430), which is the correct order.

**No concrete defect asserted.** The only candidate is the cross-arch `pkg` step, which I am explicitly leaving UNCERTAIN. A low-confidence secondary note: `detectIcon` matches any `.png` whose path merely contains `icon` (utils.js:394-402) and copies it to `app.icns` (:206, :303), so an unrelated UI asset can become the bundle icon — cosmetic, not a build failure.

---

## arduino-firmware

**Verdict: UNCERTAIN.** No artifact/verify or path defect exists; the residual risks are PlatformIO's acceptance of `src_dir = .` for a root-level sketch (unverified) and a library step that can never fail.

- Installs PlatformIO, resolves libraries, runs `pio run` (or one `-e` per declared env), copies the first `firmware.hex`/`firmware.bin` to `release_firmware` and the ELF alongside, verifies and releases `release_firmware*`.
- Generated YAML: `/tmp/audit/out/arduino-firmware__arduino-ino.yml`, `...__arduino-ini.yml`.

**(a) ARTIFACT/VERIFY MISMATCH — ABSENT (confirmed, and flagged in-repo as a previous false alarm).** The build step creates `release_firmware` and optionally `release_firmware.elf` (arduino-firmware.js:171-174); `glob = 'release_firmware*'` (:182) matches both; `verifyCommand` tests `release_firmware` (:184). I also confirmed that `find .pio -name "firmware.hex" -o -name "firmware.bin"` is **not** the usual `-o` precedence bug — with no explicit action GNU find applies the implicit `-print` to the whole expression, and a local test printed both files.

**(b) NAME SHADOWING — ABSENT.** `pio` resolves via the setup-python Scripts dir; `.` is not on `PATH`.

**(c) SILENT SUCCESS — PRESENT (limited).** arduino-firmware.js:162 `pio pkg install 2>/dev/null || pio lib install 2>/dev/null || true` is unconditionally green and discards stderr, so a failed library resolution is invisible in the log; the later `pio run` would usually fail on a missing include, so this is loss of diagnosis more than a fully silent success.

**(d) MISSING TOOLCHAIN — ABSENT.** `pip install platformio` + `pio`; the platform toolchains download during `pio run`.

**(e) PRIVILEGES — ABSENT.** (f) **RUNNER MISMATCH — ABSENT.** (g) **PATH MISMATCH — ABSENT.** Artifacts land in the workspace root. (h) **ORDERING — ABSENT.**

**Uncertainty (not asserted as a defect).** For a sketch at the repo root the scaffold emits `src_dir = .` (arduino-firmware.js:103) and `[env:default]`/`default_envs = default` (:98, :107). PlatformIO documents `src_dir` as any `DirPath`, so `.` should be accepted, but I could not verify from source that a root `.ino` whose name differs from the project folder builds cleanly; if PlatformIO rejects or mis-globs it the build fails at `pio run`. I am recording this as UNCERTAIN, not as a defect.

---

## MOST LIKELY TO BREAK, RANKED

1. **windows-exe — malformed PyInstaller argv in the Python branch (windows-exe.js:132/135/138 + :157).** Highest confidence: the rendered `@('--icon app.ico', '--add-data "templates;templates"', '--hidden-import mypkg.sub', …)` is splatted one element per argv entry, and argparse cannot split a token on the embedded space. Any Python project with a detected icon, data directory, or hidden import fails the build. The mac-app code builds the same flags correctly as a shell string, which is the control that proves the intent. The smoke harness misses it because its fixture ships `build.py` and never reaches this branch.

2. **rpi-distro — Python dependency install is silently skipped on Bookworm (rpi-distro.js:74, :76-83, :416).** `pip3 install -r requirements.txt` fails under PEP 668 (`externally-managed-environment`) with no venv, and `|| true` swallows it; the workflow reports success and releases an image whose `morpheus-app` service crash-loops on first boot. The adapter's own `aiNotes` claim a venv that the code never creates, so the documented contract and the implementation directly disagree. linux-distro.js:107 does it right, which confirms the intended design.

3. **android-apk — generated manifest references a mipmap the scaffold never creates (android-apk.js:230 vs :211-243).** Confirmed by rendering the scaffold: no `res/mipmap*` file is produced, so AAPT2's link step fails with `resource mipmap/ic_launcher not found` precisely for the manifest-less project this injection path is meant to support.

4. **android-apk — Gradle/AGP version pairing (utils.js:363, :367, :338; android-apk.js:285).** `default: '8.7'` is below the minimum for AGP ≥ 8.7 (8.9 / 8.10.2 / 8.11.1), unknown major (AGP 9.x) collapses to 8.5, AGP declared only in `app/build.gradle` is read as unknown, and the clamp at :285 only ever clamps *down*, so an old wrapper is kept even when the AGP demands newer. Conditional on the project's wrapper/AGP shape, but the logic error is unambiguous in the text.

5. **rpi-distro / linux-distro — `|| true` on dependency installs (rpi-distro.js:73-74; linux-distro.js:105, :108).** A green build can ship an image whose app cannot start; the failure surfaces only on first boot, never in the workflow log. Same class as the calibration bug.

6. **arduino-firmware — library resolution can never fail (arduino-firmware.js:162).** `pio pkg install 2>/dev/null || pio lib install 2>/dev/null || true` is always green and hides its own diagnostics, so a missing-library build is harder to diagnose. Low impact because `pio run` normally fails next.

7. **mac-app — cross-architecture `pkg` build depends on Rosetta 2 (mac-app.js:280).** `@yao-pkg/pkg`'s docs require Rosetta 2 to build `macos-x64` from an arm64 host, and `macos-latest` is arm64. If Rosetta 2 is absent on the image, the x64 `pkg` step fails; I could not confirm its presence, so this stays UNCERTAIN rather than a claimed defect.

### Classes found ABSENT everywhere (with the one exception noted)
- **ARTIFACT/VERIFY MISMATCH:** absent for all six — every `verifyCommand` tests exactly the path the build step writes, and every `glob` matches those same workspace paths (arduino included; it is the repo's own named false alarm).
- **PATH MISMATCH / outside-workspace artifacts:** absent for all six — nothing is written to `$RUNNER_TEMP` or outside `GITHUB_WORKSPACE`.
- **NAME SHADOWING:** absent for all six — no `python -m <module>` shadowing, `gradlew` is regenerated, and no `cd` leaks between steps.
- **RUNNER MISMATCH:** absent for all six — macOS-only tools are only used on `macos-latest`, PowerShell only on `windows-latest`.
- **ORDERING:** absent for all six — verify before release, producers before consumers, correct heredoc/staging order.
- **PRIVILEGES:** absent for android/windows/mac/arduino; likely absent for rpi (pi-gen's own `--privileged` path on a GitHub VM) and unverified for linux (mkosi).
