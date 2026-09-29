// How to run a command on this platform — the one thing that genuinely differs between macOS, Linux
// and Windows, kept in ONE import-free module so it can be asserted in CI without a Windows machine.
//
// WHY THIS EXISTS. `scripts/portable-setup.mjs` and `server/scripts/dev-db.mjs` both shell out, and
// both were written on macOS where `spawnSync('npm', ...)` and `execFileSync('.../.bin/prisma', ...)`
// simply work. On Windows neither does: npm and Prisma are `.cmd` shims, and Node 20 REFUSES to
// spawn a `.cmd` without a shell (CVE-2024-27980's fix), throwing EINVAL. So the install would get
// several steps in on Linux and macOS and die on Windows at the first npm call — the worst shape a
// platform bug can have, because it looks like it works.
//
// This module is pure: it takes the platform as an argument and returns argv arrays. The guards
// exercise all three platforms from one machine, which is the only way a Windows path gets tested
// here at all.
//
// THE RULE, stated once: a command that POSIX runs directly, Windows needs `cmd.exe /c` for. Node's
// own executable is a real .exe on every platform and is deliberately NOT wrapped.

/** Windows `cmd.exe` refuses an argument containing any of these, so a Node path is quoted instead. */
const CMD_UNSAFE = /[\s&|<>^]/;

/**
 * Quote one argument for `cmd.exe /c`.
 *
 * `cmd` does not follow POSIX quoting rules, and its own metacharacters are live even inside double
 * quotes: `%` expands a variable and `!` expands when delayed expansion is on. Escaping them is
 * cheaper than proving they cannot appear, and a wrong build here is a command that runs something
 * else. Arguments that need none of this come back untouched, so the common case stays readable.
 */
export function quoteForCmd(arg) {
  const value = String(arg);
  const needsQuoting = CMD_UNSAFE.test(value) || value === '';
  // `%` → `%%` is only special inside a batch file, but it is harmless in a `cmd /c` string and it is
  // the form that stays correct if anyone ever wraps this in one.
  const escaped = value.replace(/%/g, '%%');
  return needsQuoting ? `"${escaped}"` : escaped;
}

/**
 * The argv to run an executable by PATH name (npm, git, node) on this platform.
 *
 * On Windows this goes through `cmd.exe /c`, which is what lets `npm` resolve to `npm.cmd` — the
 * shim Node 20 will not spawn directly.
 */
export function pathCommand(platform, command, args = []) {
  const argv = [String(command), ...args.map(String)];
  if (platform !== 'win32') return argv;
  return ['cmd.exe', '/c', argv.map(quoteForCmd).join(' ')];
}

/**
 * The argv to run a script with THIS Node, on any platform. Node is a real executable everywhere, so
 * it is never wrapped — and going through Node rather than a `#!/bin/sh` shim is what makes these
 * scripts platform-neutral in the first place.
 */
export function nodeCommand(execPath, script, args = []) {
  return [execPath, script, ...args.map(String)];
}

/**
 * The argv to run a CLI that lives in `node_modules/.bin`.
 *
 * On Windows that directory holds `name.cmd`, `.ps1` and a shebang-only `name` — the last of which
 * Node cannot execute and `cmd.exe` may resolve to anyway, depending on PATHEXT. Naming the `.cmd`
 * explicitly removes the ambiguity, and `cmd.exe /c` is what can run it.
 */
export function binCommand(platform, binPath, args = []) {
  const bin = platform === 'win32' ? `${binPath}.cmd` : binPath;
  const argv = [bin, ...args.map(String)];
  if (platform !== 'win32') return argv;
  return ['cmd.exe', '/c', argv.map(quoteForCmd).join(' ')];
}

/**
 * How to spawn a command on this platform: `{ shell }` for `spawnSync`/`execFileSync`.
 *
 * DELIBERATELY `shell: false` EVERYWHERE. `pathCommand` and `binCommand` already produce a complete
 * argv — on Windows that is `cmd.exe /c <joined string>` — so passing `shell: true` as well would wrap
 * it a second time (`cmd.exe /c "cmd.exe /c npm install"`). Both work, which is why the doubling is
 * dangerous rather than loud: it looks fine, quotes twice, and differs between the two CLIs. One
 * mechanism, stated here, so there is nothing to get subtly wrong per call site.
 */
export function spawnOptions(platform) {
  return { shell: false };
}

/**
 * The install steps a HUMAN does, per platform, before the one command that does the rest.
 *
 * This is what makes the download actionable rather than merely present: a new user on each platform
 * gets the exact prerequisite commands for their machine, and the same one command afterwards. It is
 * DATA because three of the four things that go wrong on a fresh machine are outside this repo's
 * control (no Node, no compiler for a native dependency, no way to double-click a shell script), and
 * a setup that only says "run npm install" leaves the user to guess which of those it was.
 */
export const PLATFORM_STEP_RESULT = 'http://localhost:4500 opens and shows the Morpheus sign-in page';

export const PLATFORM_STEPS = {
  darwin: {
    label: 'macOS',
    prerequisites: [
      { need: `Node ${20}+ and npm`, how: 'Install from https://nodejs.org (the .pkg installer), or: brew install node' },
      { need: 'The Xcode command line tools', how: 'xcode-select --install — a native dependency needs a compiler; you likely already have them' },
      { need: 'No database to install', how: 'the setup starts its own local PostgreSQL under server/data/pg' },
    ],
    launcher: 'Portable-Morpheus.command',
    launcherNote: 'Double-click it in Finder. If macOS refuses it (Gatekeeper quarantines downloaded files), right-click → Open, or run: xattr -d com.apple.quarantine "Portable-Morpheus.command"',
    terminal: 'Terminal.app, in the folder you unzipped',
  },
  linux: {
    label: 'Linux',
    prerequisites: [
      { need: `Node ${20}+ and npm`, how: 'Use your package manager or https://nodejs.org — e.g. sudo apt install nodejs npm, or sudo dnf install nodejs npm. Check with: node -v' },
      { need: 'A C toolchain and make', how: 'sudo apt install build-essential (Debian/Ubuntu) or sudo dnf groupinstall "Development Tools" (Fedora) — a native dependency builds against them' },
      { need: 'No database to install', how: 'the setup starts its own local PostgreSQL under server/data/pg' },
    ],
    launcher: 'Portable-Morpheus.desktop',
    launcherNote: 'Run: chmod +x Portable-Morpheus.desktop, then double-click it. Some desktops ask you to trust it the first time; if it does nothing, run ./Portable-Morpheus.desktop in a terminal and read the output',
    terminal: 'any terminal, in the folder you unzipped',
  },
  win32: {
    label: 'Windows',
    prerequisites: [
      { need: `Node ${20}+ and npm`, how: 'Install the LTS .msi from https://nodejs.org, then open a NEW Command Prompt so PATH updates' },
      { need: 'No C toolchain needed', how: 'the dependencies this install uses ship prebuilt binaries for Windows' },
      { need: 'No database to install', how: 'the setup starts its own local PostgreSQL under server\\data\\pg' },
    ],
    launcher: 'Portable-Morpheus.bat',
    launcherNote: 'Double-click it in Explorer. SmartScreen may warn about a downloaded .bat: More info → Run anyway',
    terminal: 'Command Prompt or PowerShell, in the folder you unzipped',
  },
};

/** The steps for a platform, or null when this install cannot support it at all. */
export function platformSteps(platform) {
  return PLATFORM_STEPS[platform] || null;
}

/**
 * The one command that does the rest.
 *
 * Deliberately the SAME string on every platform: forward slashes work in `cmd.exe`, and a
 * platform-conditional here would be a second spelling of one path for no benefit. Kept as a function
 * rather than inlined so the guard can assert there is exactly one form.
 */
export function setupCommand() {
  return 'node scripts/portable-setup.mjs';
}
