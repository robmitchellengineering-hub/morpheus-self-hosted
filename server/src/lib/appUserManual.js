// The user manual that travels with a compiled app.
//
// WHY THIS EXISTS (Rob, 2026-10-01, after downloading the compiled WikiData Batch Uploader and
// hitting four separate walls in a row): "there also needs to be a downloadable user manual that
// comes with a compiled app." He had the disk image in front of him and no way to know which of
// two downloads was for his Mac, that the crossed-out icon meant "wrong architecture", that macOS
// had moved the menu bar to the top of the screen, or that any of it was expected. Every answer
// existed somewhere in Morpheus, in a chat, or in a CI log. None of it was in the download.
//
// So the manual is written from what Morpheus ACTUALLY KNOWS at compile time and nothing else:
//   - what was built, for which machine, when;
//   - how to install and start that kind of artifact on that platform;
//   - where the platform's own hurdles are (Gatekeeper, SmartScreen, unsigned packages);
//   - and the project's own README, quoted in full and clearly labelled as the project's, because
//     the one thing Morpheus cannot know is what the app does inside.
//
// The rule this module is built to: it may not assert anything it cannot see. It does not describe
// features it has not read, and where it would have to guess it says the app's own interface is the
// authority. A manual that invents a menu item is worse than no manual — that is exactly the shape
// of failure this codebase keeps re-learning.
//
// Import-free, so it runs in CI's no-install guards job.

export const USER_MANUAL_FILE = 'USER-MANUAL.txt';

// The heredoc terminator the generated workflow writes the manual with. Anything equal to this line
// inside the manual would END the heredoc early and let the rest of the manual run as shell commands
// — with the workflow's `contents: write` token. Project content (its README) goes into the manual,
// so this is not hypothetical: sanitizeHeredocBody() below is the guard.
export const USER_MANUAL_DELIMITER = 'MORPHEUS-USER-MANUAL-END';

// A line that only differs from the delimiter by surrounding whitespace still terminates a heredoc,
// so the comparison is on the trimmed line.
export function sanitizeHeredocBody(text, delimiter = USER_MANUAL_DELIMITER) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => line.trim() !== delimiter)
    .join('\n');
}

// Target-specific installation. Each entry is { install, firstRun, trouble } — kept as plain strings
// so the manual reads the same wherever it lands (a .txt in a disk image, next to a .exe, a release
// asset someone opens in a browser).
const PLATFORM_GUIDES = {
  'mac-app': {
    install: [
      'You downloaded a disk image (.dmg).',
      '  1. Double-click it — Finder mounts it like a USB stick.',
      '  2. Drag the app onto the Applications shortcut sitting next to it.',
      '  3. Eject the disk image (the eject arrow beside it in Finder).'
    ],
    firstRun: [
      'The menu bar for a Mac app is at the TOP OF THE SCREEN, next to the  logo — not inside the',
      'window. If a window looks empty, click it once and look up there.'
    ],
    trouble: [
      'NOT SIGNED: this app is not signed with a paid Apple Developer certificate, so macOS will',
      'probably refuse the first launch — "Apple could not verify ... is free of malware", or the',
      'older "...is damaged and can\'t be opened. You should move it to the Bin." It is not damaged.',
      '  Fix: open Terminal (Applications -> Utilities) and run, with the path to YOUR app:',
      '      xattr -cr /Applications/YourApp.app',
      '  Then open it again. Or: System Settings -> Privacy & Security, scroll down, and click',
      '  "Open Anyway" after the first attempt.',
      'CROSSED-OUT ICON (a circle with a line through it): that means the build is for a different',
      'kind of Mac, not that the file is broken. Download the other one — "intel" for an Intel Mac,',
      '"apple-silicon" for an M-series Mac. Apple menu -> About This Mac names your chip.'
    ]
  },
  'windows-exe': {
    install: [
      'You downloaded a .zip. Unzip it first — running an .exe from inside a zip does not work.',
      'Then double-click the .exe inside the extracted folder.'
    ],
    firstRun: [
      'Windows may show "Windows protected your PC" (SmartScreen). Choose "More info", then',
      '"Run anyway". This appears for any program that is not signed with a paid certificate.'
    ],
    trouble: [
      'Nothing on screen after launching: this app may have been built without a console window, so',
      'it prints nothing and a crash is silent. Look for a log file next to the .exe or under',
      '%APPDATA%.'
    ]
  },
  'linux-binary': {
    install: [
      'You downloaded a .tar.gz.',
      '  tar xzf <the file>.tar.gz',
      '  chmod +x <the binary inside>',
      '  ./<the binary inside>'
    ],
    firstRun: ['If it exits at once, run it from a terminal so you can see why.'],
    trouble: ['A missing shared library names itself in the terminal output; install that package.']
  },
  'python-package': {
    install: [
      'You downloaded a Python package (a wheel or a source archive).',
      '  pip install <the file>',
      'Then run the module or entry point the project documents.'
    ],
    firstRun: ['A virtual environment (python -m venv) is worth it if you do not want it system-wide.'],
    trouble: ['A failed install names the requirement it could not satisfy.']
  },
  'android-apk': {
    install: [
      'You downloaded an Android .apk.',
      '  1. Copy it to the device (or open the download on the device itself).',
      '  2. Your browser or Files app will ask to install an unknown app — allow it for that app only.',
      '  3. Android will warn that it cannot check the app for harmful behaviour. That is Play',
      '     Protect reacting to an unsigned build, not a finding about this app.'
    ],
    firstRun: ['Open it from the app drawer once installed.'],
    trouble: ['"App not installed" usually means an older build with a different signing key is already present — uninstall that first.']
  },
  'ios-app': {
    install: [
      'You downloaded an iOS .ipa. An .ipa only installs on a device it was signed for.',
      'On a normal iPhone this needs a Mac with Xcode (or a sideloading tool) and a signing',
      'identity that includes your device — Apple does not allow installing unsigned apps.'
    ],
    firstRun: ['The first launch of a sideloaded app is refused until you trust the developer in Settings -> General -> VPN & Device Management.'],
    trouble: ['"Unable to Install" almost always means the signing identity does not cover this device.']
  },
  'web-app': {
    install: [
      'You downloaded a static web build (.zip). Unzip it and serve the folder — it is plain files.',
      '  npx serve <the folder>',
      'or upload the folder to any static host.'
    ],
    firstRun: ['Open the served address in a browser.'],
    trouble: ['A blank page with no errors is usually a build that expects to be served from the root of a domain.']
  },
  'rpi-distro': {
    install: [
      'You downloaded a disk image for a Raspberry Pi.',
      'Write it to a microSD card with Raspberry Pi Imager (or balenaEtcher) — pick "Use custom',
      'image" and choose this file. Then boot the Pi.'
    ],
    firstRun: ['The first boot takes several minutes while it resizes and sets itself up.'],
    trouble: ['A Pi that never appears on the network: re-check that the image was written to the card, not to a file.']
  },
  'linux-distro': {
    install: [
      'You downloaded a disk image. Write it to a USB stick or disk with balenaEtcher, or boot it',
      'directly in a virtual machine.'
    ],
    firstRun: ['Nothing is installed on your computer until you run the installer from the booted system.'],
    trouble: ['A machine that will not boot it usually has Secure Boot enabled — turn it off for the install.']
  },
  'arduino-firmware': {
    install: [
      'You downloaded firmware for a board. Flash it with the tool the project documents',
      '(avrdude, esptool, or the Arduino IDE\'s "Upload" with the binary).'
    ],
    firstRun: ['Most boards need a reset (or a double-tap of the reset button) to enter the bootloader for flashing.'],
    trouble: ['A board that reports no port is usually a missing USB serial driver, not the firmware.']
  },
  'audio-plugin-macos': {
    install: [
      'THIS PLUGIN IS FOR MACOS ONLY. It will not load on Windows or Linux — there is no Audio Unit',
      'outside Apple\'s platforms, and the .vst3 and .clap in this download are macOS bundles. If you',
      'or your collaborators are on Windows, this is not the build for them.',
      '',
      'You downloaded FOUR zips because a plugin is four files in four different places, and a DAW',
      'only looks in its own. Unzip them and move each one to its folder — the USER one only needs',
      'your account, the SYSTEM one needs your password and is shared by everyone on the Mac.',
      '',
      '  VST3      ->  ~/Library/Audio/Plug-Ins/VST3/',
      '  AU        ->  ~/Library/Audio/Plug-Ins/Components/',
      '  CLAP      ->  ~/Library/Audio/Plug-Ins/CLAP/',
      '  standalone ->  anywhere you like; it is an ordinary app, double-click it.',
      '',
      'If the folder does not exist, make it: open Finder, press Shift-Command-G, paste the line',
      'above without the trailing slash, and create it.'
    ],
    firstRun: [
      'A DAW scans its plugin folders at startup, so QUIT AND REOPEN IT — a plugin installed while',
      'it was running usually will not appear.',
      'Ableton, Reaper, Bitwig and Cubase take the VST3. LOGIC, GARAGEBAND AND MAIN STAGE TAKE ONLY',
      'THE AU — they cannot load a VST3 at all, so install the .component for those.',
      'The plugin is listed under the vendor name from its manifest, not under "Morpheus", unless',
      'that is what you put there.'
    ],
    trouble: [
      'NOT SIGNED: this plugin has no paid Apple Developer certificate, so macOS may quarantine it',
      'and the DAW will not see it even though the file is there. That is not a broken plugin.',
      '  Fix: open Terminal (Applications -> Utilities) and run, with the path to YOUR plugin:',
      '      xattr -cr ~/Library/Audio/Plug-Ins/VST3/"Your Plugin.vst3"',
      '  Do the same for the .component, then reopen the DAW.',
      'NOT LISTED IN LOGIC: Logic only reads Audio Units. If you installed the .vst3 only, install',
      'the .component as well. If it is installed and still missing, run',
      '      auval -v aufx SUBT MANU',
      'with the four-character codes from morpheus.plugin.json — it reports what Logic objects to.',
      'TWO PLUGINS WITH THE SAME NAME: the AU registration codes in morpheus.plugin.json must be',
      'unique. Change auSubtype, rebuild, and reinstall — a duplicate makes one of them invisible.',
      'INSTALLED THE WRONG ARCHITECTURE: this build is universal (Intel and Apple silicon), so it',
      'should load on either. If an older copy is still installed, delete it before installing this one.'
    ]
  },
  'audio-plugin-windows': {
    install: [
      'THIS PLUGIN IS FOR WINDOWS ONLY. It will not load on macOS or Linux. There is also no Audio Unit in',
      'it — only Apple has those — which is why this download has three files where the macOS one has',
      'four. If you are on a Mac, build the MACOS AUDIO PLUGIN route instead.',
      '',
      'You downloaded THREE zips because a plugin is three files in two different places, and a DAW only',
      'looks in its own. Unzip them and move each one to its folder — the "Common Files" folders are',
      'shared, so copying into them needs administrator rights.',
      '',
      '  VST3        ->  C:\\Program Files\\Common Files\\VST3\\',
      '  CLAP        ->  C:\\Program Files\\Common Files\\CLAP\\',
      '  standalone  ->  anywhere you like; it is an ordinary .exe, double-click it.',
      '',
      'If a folder does not exist, create it. The name must match exactly, because the host looks for the',
      'path and not for the file.'
    ],
    firstRun: [
      'A DAW scans its plugin folders at startup, so QUIT AND REOPEN IT — a plugin installed while it was',
      'running usually will not appear.',
      'Ableton, Reaper, Bitwig, Cubase and Studio One take the VST3. CLAP is supported by Reaper, Bitwig',
      'and a growing list of hosts; if your DAW does not list it, install the VST3 as well.',
      'The plugin is listed under the vendor name from its manifest, not under "Morpheus", unless that is',
      'what you put there.',
      '64-BIT ONLY: this build is x64. A 32-bit DAW cannot load it, and that is the most common reason a',
      'plugin installs and never appears.'
    ],
    trouble: [
      'NOT SIGNED, AND ON WINDOWS THAT MATTERS LESS THAN YOU WOULD THINK: plugins load unsigned in every',
      'DAW, so a VST3 or CLAP that does not appear is almost always in the wrong folder or was skipped by',
      'the scan — check the path above first.',
      'SMARTSCREEN: the standalone .exe is unsigned, so Windows may show "Windows protected your PC" the',
      'first time you run it. Choose "More info" and then "Run anyway". That is the unsigned-file warning,',
      'not a detection.',
      'NOT LISTED: check that the .vst3 is directly in the VST3 folder and not inside a subfolder created',
      'by unzipping. A VST3 on Windows is a single FILE, so a folder containing one is not installed.',
      'TWO PLUGINS WITH THE SAME NAME: the id in morpheus.plugin.json is what hosts key on, and two plugins',
      'sharing one shadow each other. Change the id and rebuild.'
    ]
  },
  _default: {
    install: ['This build produced the file(s) named above. The project\'s own notes below say what to do with them.'],
    firstRun: [],
    trouble: []
  }
};

const README_CANDIDATES = ['README.md', 'readme.md', 'README.txt', 'readme.txt', 'README', 'readme', 'USAGE.md', 'USAGE.txt'];

// The project's own documentation, if it shipped one. Returns { path, content } or null.
export function projectReadme(files) {
  if (!Array.isArray(files)) return null;
  for (const candidate of README_CANDIDATES) {
    const hit = files.find((f) => f && f.path === candidate);
    if (hit && String(hit.content || '').trim()) {
      return { path: hit.path, content: String(hit.content).trim() };
    }
  }
  return null;
}

// When a build publishes more than one file, the manual has to say which one is whose — that was
// the single most expensive confusion of 2026-10-01 (two disk images, one Mac, no way to tell).
const ARCH_HINTS = {
  intel: 'for an Intel Mac',
  'apple-silicon': 'for an Apple-silicon Mac (M1 and later)',
  universal: 'for any Mac - Intel or Apple silicon'
};

export function manualDownloads({ artifactGlob, runners } = {}) {
  if (!Array.isArray(runners) || runners.length < 2) return null;
  const glob = String(artifactGlob || '');
  return runners.map((r) => {
    const file = glob.replace('${{ matrix.arch }}', r.arch);
    return `${file} - ${ARCH_HINTS[r.arch] || r.arch}`;
  });
}

function bullets(lines, indent = '  ') {
  return (lines || []).map((l) => (l ? `${indent}${l}` : '')).join('\n');
}

export function renderUserManual({ projectName, target, targetLabel, files, generatedAt, downloads } = {}) {
  const name = String(projectName || 'This app').trim() || 'This app';
  const guide = PLATFORM_GUIDES[target] || PLATFORM_GUIDES._default;
  const label = targetLabel || target || 'build';
  const when = generatedAt || new Date().toISOString().slice(0, 10);
  const readme = projectReadme(files);

  const rule = '='.repeat(Math.min(74, Math.max(20, name.length + 16)));
  const out = [];

  out.push(rule);
  out.push(`${name} — user manual`);
  out.push(rule);
  out.push('');
  out.push(`  What this is : a ${label} build, compiled for you by Morpheus`);
  out.push(`  Generated    : ${when}`);
  out.push('');
  out.push('  This file travelled with your download. It covers installing the app, starting it, and');
  out.push('  the things that platform does to unsigned software. It is written from what Morpheus');
  out.push('  knew at compile time — for what the app does once it is running, see the project\'s own');
  out.push('  notes at the bottom.');
  out.push('');

  if (Array.isArray(downloads) && downloads.length > 1) {
    out.push('WHICH DOWNLOAD IS MINE?');
    out.push('  This build published more than one file. They are the same app built for different');
    out.push('  machines — installing the wrong one gives you "not supported on this Mac" or a');
    out.push('  crossed-out icon, not a broken file.');
    out.push(bullets(downloads.map((d) => `- ${d}`)));
    out.push('');
  }

  out.push(`INSTALLING IT (${label})`);
  out.push(bullets(guide.install));
  out.push('');

  if (guide.firstRun && guide.firstRun.length) {
    out.push('STARTING IT');
    out.push(bullets(guide.firstRun));
    out.push('');
  }

  if (guide.trouble && guide.trouble.length) {
    out.push('IF IT WILL NOT OPEN, OR WILL NOT START');
    out.push(bullets(guide.trouble));
    out.push('');
  }

  out.push('CONNECTING IT TO MORPHEUS');
  out.push('  Some compiled apps can sign in to Morpheus from inside the app, so the work they do is');
  out.push('  billed to your own account. That is a device login: the app shows a short code, you');
  out.push('  approve it in your browser on the Morpheus site, and the app picks up a token scoped to');
  out.push('  one capability. If the app has no such screen, it does not need one.');
  out.push('');

  out.push('-'.repeat(74));
  out.push(`THE PROJECT'S OWN NOTES (${readme ? readme.path : 'none shipped'})`);
  out.push('-'.repeat(74));
  out.push('');
  if (readme) {
    out.push('  Everything below is quoted from the project itself, not written by Morpheus.');
    out.push('');
    out.push(readme.content);
  } else {
    out.push('  This project did not ship a README, so there is nothing here to quote. Morpheus will');
    out.push('  not invent one: it has not read the app\'s interface, and a manual that describes menus');
    out.push('  that do not exist is worse than a short one. What the app does when you open it is the');
    out.push('  authority.');
  }
  out.push('');
  out.push('-'.repeat(74));
  out.push(`End of manual. ${readme ? `The section above is ${readme.path}; ` : ''}the app itself is the authority on what it does.`);

  return sanitizeHeredocBody(out.join('\n')) + '\n';
}
