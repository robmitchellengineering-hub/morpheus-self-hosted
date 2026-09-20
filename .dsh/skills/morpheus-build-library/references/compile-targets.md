# Native compile targets: what can only be learned by running them

## Reading an adapter is not evidence

Two separate paper audits of the compile adapters came up clean. The only hard
evidence available — a real run log — showed `python-package` failing **every
time** with `PyInstaller produced no .exe`, because the verify gate expected a
Windows extension on a Linux runner. Invisible in the source, obvious in the log.

`node scripts/compile-smoke.mjs --targets web-app,python-package` (or `--all
--include-expensive`) generates each target's real workflow, dispatches it on
GitHub Actions, and reports the runner's actual conclusion per target. Runner
minutes cost real money — macOS bills at 10×, Windows 2× — so name the targets
you have reason to doubt.

## Never let `|| true` swallow a dependency install

`rpi-distro.js` ran `pip3 install -r requirements.txt … || true` with no venv. On
Raspberry Pi OS Bookworm (PEP 668) pip aborts with
`externally-managed-environment`, the `|| true` eats it, and the workflow
**passes** while releasing an image whose `morpheus-app` service crash-loops on
first boot. The adapter's own `aiNotes` claimed a venv the code never created —
the documented contract and the implementation disagreed, and the green tick
covered it. `linux-distro.js` does it correctly; that is the control.

## Shell and toolchain traps that produce green-but-dead builds

- **PowerShell array splatting passes each element as ONE argv entry.**
  `@('--icon app.ico', '--add-data "templates;templates"', …)` hands PyInstaller
  the literal tokens; argparse does not split a token on the embedded space. Any
  Python project with a detected icon, data directory or hidden import fails.
  `mac-app` builds the same flags as a shell string, which is what proves the
  intent. The smoke harness missed it because its fixture shipped `build.py` and
  never reached that branch.
- **A project's own `build.py` shadows `python -m build`** — the working
  directory is on `sys.path`, so Python runs that file instead. It exits 0, no
  `dist/` appears, and the failure surfaces later with nothing in the log saying
  why. Run the project's own build script or pinned lockfile rather than
  regenerating a weaker one.
- **An artifact lookup must key on the build, not the project.** Keyed on the
  project, every recompile — RECOMPILE, "try again", an auto-fix retry — silently
  kept serving the first build ever saved, and the UI said "succeeded".
- **Never buffer a compiled artifact in memory.** Stream the download and the
  upload. Buffering produced a backend that crash-restarted 3 times in a
  47-minute window with no app-level error — consistent with a hard OOM kill.

## Detect the project type from evidence, not from a file's existence

`isNodeProject(files)` checked only whether `package.json` existed. A 100%
Python PyQt6 project containing a stray, never-created `index.js` had every
target's Node-vs-Python branch silently pick Node and try to bundle `main.py`
with a JS packager. The same class: scanning only `.ino` for sketches meant a
real modular ESP32/ESP8266 project fell back to `uno`/`atmelavr` and failed
against ESP-only APIs — the detection has to cover `.cpp`/`.c`/`.h`/`.hpp` too.

## Platform limits worth stating rather than fighting

A macOS `.dmg` cannot ship unsigned: Gatekeeper refuses a fully unsigned binary
with an **"is damaged"** message, and anything downloaded via a browser carries
`com.apple.quarantine`, which makes it worse. Signing means a paid Apple
Developer account — a real cost and a real decision for Rob, not something to
start doing quietly inside a compile adapter.
