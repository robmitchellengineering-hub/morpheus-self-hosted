// Raspberry Pi Distro compile target — produces a bootable .img.gz using pi-gen.
// The app and its dependencies are baked into the image at build time (not
// first-boot), so the image is a fully operational OS on first boot. The release
// also bundles a flash.sh SD-card writer and OS-README.md so the user can write
// the image straight to a device.

import { isNodeProject, isPythonProject, detectPythonEntry, detectNodeEntry } from './utils.js';

// Read the optional morpheus-distro.json from the project file tree — the UI
// (DistroConfigDialog) writes this so users can customise the image without
// hand-editing pi-gen stage files. Returns null if absent or unparseable.
function readDistroConfig(files) {
  const f = files.find(x => x.path === 'morpheus-distro.json' || x.path.endsWith('/morpheus-distro.json'));
  if (!f || !f.content) return null;
  try { return JSON.parse(f.content); } catch { return null; }
}

// Pinned pi-gen commit for reproducible builds. A floating HEAD means an
// upstream pi-gen change can break builds with no app-side change; bump this
// ref when an upstream fix is needed.
const PI_GEN_REF = 'ccafc13f2574c7ab2445f71a0e9f4e2cbf2bb0b3';

export const rpiDistro = {
  id: 'rpi-distro',
  label: 'Raspberry Pi Distro',
  runner: 'ubuntu-latest',

  validate(files) {
    // Always valid — pi-gen can build a minimal image even with no app
    return { valid: true, warnings: [] };
  },

  scaffold(files) {
    return { files: [...files], generated: [], warnings: [] };
  },

  buildSteps(files) {
    const isNode = isNodeProject(files);
    const isPython = isPythonProject(files);
    const pythonEntry = detectPythonEntry(files);

    // Optional distro customisation from morpheus-distro.json (UI-managed).
    const cfg = readDistroConfig(files) || {};
    const hostname = cfg.hostname || '';
    const timezone = cfg.timezone || '';
    const locale = cfg.locale || '';
    const sshEnabled = cfg.sshEnabled !== false;
    const sshPublicKey = cfg.sshPublicKey || '';
    const firstUserPass = cfg.firstUserPass || 'morpheus';
    const wifiSsid = cfg.wifiSsid || '';
    const wifiPassword = cfg.wifiPassword || '';
    const wifiCountry = (cfg.wifiCountry || '').toUpperCase();
    const extraPackages = Array.isArray(cfg.extraPackages) ? cfg.extraPackages.filter(p => typeof p === 'string' && p.trim()) : [];
    const extraRunCommands = Array.isArray(cfg.extraRunCommands) ? cfg.extraRunCommands.filter(c => typeof c === 'string' && c.trim()) : [];

    // apt packages installed into the image at build time
    const packages = [];
    if (isNode) packages.push('nodejs', 'npm');
    if (isPython) packages.push('python3', 'python3-pip');
    // locales is required to actually generate the chosen locale (see bake script).
    if (locale) packages.push('locales');
    for (const p of extraPackages) packages.push(p);
    const pkgList = packages.join(' ');

    // Bake script — runs inside the pi-gen chroot during the build. Installs
    // the app's dependencies into the image and registers a systemd service so
    // the app starts automatically on first boot (no network needed).
    const bakeLines = [
      '#!/bin/bash',
      'set -e',
      'cd /opt/morpheus-app'
    ];
    if (isNode) bakeLines.push('npm install --production 2>&1 || true');
    if (isPython) bakeLines.push('pip3 install -r requirements.txt 2>&1 || true');
    if (isNode || isPython) {
      const runtime = isNode ? '/usr/bin/node' : '/usr/bin/python3';
      const entry = isNode ? detectNodeEntry(files) : (pythonEntry || 'main.py');
      bakeLines.push('cat > /etc/systemd/system/morpheus-app.service <<UNIT');
      bakeLines.push('[Unit]');
      bakeLines.push('Description=Morpheus App');
      bakeLines.push('After=network.target');
      bakeLines.push('[Service]');
      bakeLines.push('ExecStart=' + runtime + ' /opt/morpheus-app/' + entry);
      bakeLines.push('WorkingDirectory=/opt/morpheus-app');
      bakeLines.push('Restart=always');
      bakeLines.push('[Install]');
      bakeLines.push('WantedBy=multi-user.target');
      bakeLines.push('UNIT');
      // Enable the service by creating the symlink manually (systemctl enable
      // is unreliable inside a chroot with no running init).
      bakeLines.push('mkdir -p /etc/systemd/system/multi-user.target.wants');
      bakeLines.push('ln -sf /etc/systemd/system/morpheus-app.service /etc/systemd/system/multi-user.target.wants/morpheus-app.service');
    }

    // Distro customisation from morpheus-distro.json (applied at build time).
    // Hostname: set /etc/hostname AND the 127.0.1.1 line in /etc/hosts so the
    // hostname and name resolution agree (otherwise `hostname` and `sudo` warn).
    if (hostname) {
      bakeLines.push('echo "' + hostname + '" > /etc/hostname');
      bakeLines.push('sed -i "s|^127\\.0\\.1\\.1.*|127.0.1.1\\t' + hostname + '|" /etc/hosts || echo "127.0.1.1\\t' + hostname + '" >> /etc/hosts');
    }
    if (timezone) {
      bakeLines.push('ln -sf /usr/share/zoneinfo/' + timezone + ' /etc/localtime');
    }
    // Locale: append to /etc/locale.gen and run locale-gen so the locale is
    // actually generated (writing /etc/default/locale alone leaves it missing
    // and apps fall back to C with locale warnings).
    if (locale) {
      bakeLines.push('echo "' + locale + ' UTF-8" >> /etc/locale.gen');
      bakeLines.push('locale-gen');
      bakeLines.push('echo "LANG=' + locale + '" > /etc/default/locale');
      bakeLines.push('echo "LC_ALL=' + locale + '" >> /etc/default/locale');
    }
    // WiFi: bake wpa_supplicant.conf into the boot partition so the Pi joins
    // the network on first boot (headless, no ethernet needed for remote SSH).
    if (wifiSsid) {
      bakeLines.push('mkdir -p /boot');
      bakeLines.push("cat > /boot/wpa_supplicant.conf <<'WPA'");
      bakeLines.push('ctrl_interface=DIR=/var/run/wpa_supplicant GROUP=netdev');
      bakeLines.push('update_config=1');
      if (wifiCountry) bakeLines.push('country=' + wifiCountry);
      bakeLines.push('');
      bakeLines.push('network={');
      bakeLines.push('  ssid="' + wifiSsid + '"');
      if (wifiPassword) {
        bakeLines.push('  psk="' + wifiPassword + '"');
      } else {
        bakeLines.push('  key_mgmt=NONE');
      }
      bakeLines.push('}');
      bakeLines.push('WPA');
    }
    // SSH public key injection is handled in a late stage2 step (below) so it
    // runs AFTER pi-gen creates the first user — the home directory then exists.
    // Custom commands run in a subshell with `|| echo` so one failing line
    // logs the error but does NOT abort the whole pi-gen build (set -e above).
    for (const cmd of extraRunCommands) {
      bakeLines.push('( ' + cmd + ' ) 2>&1 || echo "MORPHEUS: a custom run command failed (non-fatal), continuing..."');
    }

    // flash.sh — writes morpheus-os.img.gz to an SD card (Linux + macOS).
    const flashShLines = [
      '#!/bin/bash',
      '# Morpheus OS flasher — writes morpheus-os.img.gz to a Raspberry Pi SD card.',
      '# Usage: sudo ./flash.sh /dev/sdX   (Linux)   or   sudo ./flash.sh /dev/rdiskN   (macOS)',
      'set -e',
      'IMG="morpheus-os.img.gz"',
      'if [ ! -f "$IMG" ]; then echo "Missing $IMG in current directory." >&2; exit 1; fi',
      'if [ -z "$1" ]; then',
      '  echo "No device specified. Available disks:"',
      '  lsblk -d -o NAME,SIZE,MODEL 2>/dev/null || diskutil list 2>/dev/null',
      '  echo ""',
      '  echo "Re-run: sudo $0 /dev/sdX  (Linux)  or  sudo $0 /dev/rdiskN  (macOS)"',
      '  exit 1',
      'fi',
      'DEV="$1"',
      'echo "WARNING: this will overwrite everything on $DEV."',
      'read -p "Type the device name again to confirm ($DEV): " CONFIRM',
      'if [ "$CONFIRM" != "$DEV" ]; then echo "Aborted."; exit 1; fi',
      'echo "Writing $IMG to $DEV ..."',
      'if command -v diskutil >/dev/null 2>&1; then',
      '  diskutil unmountDisk "$DEV" || true',
      '  gzip -c -d "$IMG" | dd of="$DEV" bs=4m',
      'else',
      '  umount ${DEV}* 2>/dev/null || true',
      '  gzip -c -d "$IMG" | dd of="$DEV" bs=4M conv=fsync status=progress',
      'fi',
      'sync',
      'echo "Done. Insert the SD card into your Raspberry Pi and boot."'
    ];

    // flash-network.sh — pushes the image over SSH to a remote device (e.g. a
    // Raspberry Pi already on the network) and writes it to a block device
    // there, so the user can load the OS without physically touching an SD card.
    const flashNetworkShLines = [
      '#!/bin/bash',
      '# Morpheus OS network flasher — pushes the image over SSH to a remote',
      '# device (e.g. a Raspberry Pi already on your network) and writes it to a',
      '# block device there. The remote must be reachable via SSH and have sudo.',
      '# Usage: ./flash-network.sh user@host /dev/sdX',
      'set -e',
      'IMG="morpheus-os.img.gz"',
      'DEST="${1:?Usage: $0 user@host /dev/sdX}"',
      'DEV="${2:?Specify the target block device on the remote, e.g. /dev/sdX}"',
      'if [ ! -f "$IMG" ]; then echo "Missing $IMG in current directory." >&2; exit 1; fi',
      'echo "Pushing $IMG to $DEST and writing to $DEV over SSH..."',
      'echo "WARNING: this will overwrite everything on $DEST:$DEV."',
      'read -p "Type the remote device path again to confirm ($DEV): " CONFIRM',
      'if [ "$CONFIRM" != "$DEV" ]; then echo "Aborted."; exit 1; fi',
      'gzip -c -d "$IMG" | ssh "$DEST" "sudo dd of=$DEV bs=4M conv=fsync status=progress && sync"',
      'echo "Done. Image written to $DEST:$DEV. Reboot the remote device to boot from it."'
    ];

    // OS-README.md — flashing instructions for every platform.
    const readmeLines = [
      '# Morpheus OS — Raspberry Pi Bootable Image',
      '',
      'A bootable Raspberry Pi OS image with your app baked in and running on first boot.',
      '',
      '## Contents',
      '- `morpheus-os.img.gz` — bootable OS image (compressed)',
      '- `flash.sh` — local SD card flasher (Linux / macOS)',
      '- `flash-network.sh` — network flasher (push over SSH to a remote device)',
      '- `OS-README.md` — this file',
      '',
      '## Flash to SD card',
      '',
      '### Linux / macOS (flash.sh)',
      '```bash',
      'sudo ./flash.sh /dev/sdX      # Linux',
      'sudo ./flash.sh /dev/rdiskN    # macOS (use rdiskN, not diskN)',
      '```',
      'Run `sudo ./flash.sh` with no argument to list available disks first.',
      '',
      '### Over the network (flash-network.sh)',
      'Push the image to a remote Pi already on your network and write it in place:',
      '```bash',
      './flash-network.sh pi@192.168.1.50 /dev/sdX',
      '```',
      'The remote host needs SSH access and sudo. The image is decompressed and',
      'piped straight to `dd` on the remote block device — no SD card swapping.',
      '',
      '### Windows / Raspberry Pi Imager (all platforms)',
      'Use [Raspberry Pi Imager](https://www.raspberrypi.com/software/):',
      'Choose "Use custom" → select `morpheus-os.img.gz` → pick your SD card → Write.',
      '',
      '## First boot',
      sshEnabled
        ? '- SSH is enabled. Default user: `pi` / password: `' + firstUserPass + '` — **change it on first boot** with `passwd`.'
        : '- SSH is disabled. Re-flash with SSH enabled in the distro config to log in headlessly.',
      ...(sshPublicKey && sshEnabled ? ['- SSH key login is configured for the `pi` user (password login disabled).'] : []),
      ...(wifiSsid ? ['- WiFi is pre-configured to join `' + wifiSsid + '` on first boot (headless networking).'] : []),
      '- Your app starts automatically via the `morpheus-app` systemd service.',
      '',
      '```',
      'journalctl -u morpheus-app -f     # app logs',
      'systemctl status morpheus-app     # service status',
      '```'
    ];

    // Pre-build validation of distro config. Format + shell-safety checks run
    // in JS (so a raw config override with an unsafe value can't inject into the
    // generated shell); the timezone existence check runs against the runner
    // tzdata in shell. A bad value fails in seconds, not after a 10-min build.
    const RE_PASS = /^[A-Za-z0-9]{1,40}$/;
    const RE_HOSTNAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
    const RE_TZ = /^[A-Za-z0-9_/+-]+\/[A-Za-z0-9_/+-]+$/;
    const RE_LOCALE = /^[a-z]{2}_[A-Z]{2}\.UTF-8$/;
    const RE_COUNTRY = /^[A-Z]{2}$/;
    const configErrors = [];
    if (firstUserPass && !RE_PASS.test(firstUserPass)) configErrors.push('firstUserPass must be alphanumeric (1-40 chars)');
    if (hostname && !RE_HOSTNAME.test(hostname)) configErrors.push('hostname must be lowercase alphanumeric + hyphens (max 63)');
    if (timezone && !RE_TZ.test(timezone)) configErrors.push('timezone must be in Area/City form (e.g. Australia/Sydney)');
    if (locale && !RE_LOCALE.test(locale)) configErrors.push('locale must be in the form xx_XX.UTF-8');
    if (wifiCountry && !RE_COUNTRY.test(wifiCountry)) configErrors.push('wifiCountry must be a 2-letter code');
    const validateRunLines = ['echo "Validating morpheus-distro.json config..."'];
    for (const e of configErrors) validateRunLines.push('echo "ERROR: ' + e + '"');
    if (configErrors.length) {
      validateRunLines.push('exit 1');
    } else {
      if (timezone) validateRunLines.push('test -f /usr/share/zoneinfo/' + timezone + ' || { echo "ERROR: invalid timezone: ' + timezone + ' — not found in tzdata"; exit 1; }');
      if (locale) validateRunLines.push('echo "' + locale + '" | grep -Eq "^[a-z]{2}_[A-Z]{2}\\.UTF-8$" || { echo "ERROR: invalid locale format: ' + locale + '"; exit 1; }');
    }
    const validateRun = validateRunLines.join('\n');

    return [
      { uses: 'actions/checkout@v4' },
      {
        name: 'Set up Docker',
        run: 'sudo apt-get update && sudo apt-get install -y docker.io quilt parted qemu-user-static debootstrap'
      },
      {
        name: 'Clone pi-gen (pinned commit)',
        run: [
          // Defensive: this target bakes the app into the image entirely
          // from the adapter's own logic below (no AI-authored pi-gen/
          // content is ever read — see the corrected chatWithMorpheus.js
          // prompt for this target). But `git checkout FETCH_HEAD` below
          // hard-fails with "untracked working tree files would be
          // overwritten" if ANY pi-gen/ path already exists in the checked-
          // out repo (old output from before that prompt fix, a stray local
          // file, etc.) — clear it first so the clone can never collide.
          'rm -rf pi-gen',
          'git init pi-gen',
          'cd pi-gen',
          'git remote add origin https://github.com/RPi-Distro/pi-gen.git',
          '# Pinned commit for reproducible builds — a floating HEAD means an',
          '# upstream pi-gen change can break builds with no app-side change.',
          'git fetch --depth 1 origin ' + PI_GEN_REF,
          'git checkout FETCH_HEAD'
        ].join('\n')
      },
      {
        name: 'Configure pi-gen',
        run: [
          'cd pi-gen',
          '# Always generate a base config with the required pins (first user,',
          '# SSH) so headless SSH works even when a power user adds extra pi-gen',
          '# settings. A user-provided ../config is APPENDED as overrides rather',
          '# than replacing this file, so our critical defaults remain present.',
          'echo "IMG_NAME=morpheus-os" > config',
          'echo "FIRST_USER_NAME=pi" >> config',
          'echo "FIRST_USER_PASS=' + firstUserPass + '" >> config',
          sshEnabled ? 'echo "ENABLE_SSH=1" >> config' : 'echo "ENABLE_SSH=0" >> config',
          'echo "STAGE_LIST=stage0 stage1 stage2" >> config',
          'if [ -f ../config ]; then',
          '  echo "" >> config',
          '  echo "# --- user overrides from ./config ---" >> config',
          '  cat ../config >> config',
          'fi',
          'touch stage3/SKIP stage4/SKIP stage5/SKIP 2>/dev/null || true'
        ].join('\n')
      },
      {
        name: 'Inject app into image',
        run: [
          '# Create a custom pi-gen stage that copies the app and installs deps',
          'mkdir -p pi-gen/stage2/01-install-app',
          pkgList ? 'echo "' + pkgList + '" > pi-gen/stage2/01-install-app/00-packages' : 'true',
          '# Copy app files into the image (exclude build artefacts to keep it lean)',
          'mkdir -p pi-gen/stage2/01-install-app/files/opt/morpheus-app',
          '# Archive the repo root (the workflow runs here) so the app lands at',
          '# /opt/morpheus-app/ (NOT nested under the repo folder).',
          'tar --exclude="./pi-gen" --exclude="./.git" --exclude="./node_modules" --exclude="./release" -cf - . | tar -xf - -C pi-gen/stage2/01-install-app/files/opt/morpheus-app/',
          '# Bake script — installs deps + registers the service at build time',
          "cat > pi-gen/stage2/01-install-app/00-run.sh <<'FIRSTBOOT'",
          ...bakeLines,
          'FIRSTBOOT',
          'chmod +x pi-gen/stage2/01-install-app/00-run.sh'
        ].join('\n')
      },
      ...(sshPublicKey && sshEnabled ? [{
        name: 'Inject SSH key (after user creation)',
        run: [
          '# Late stage2 step — runs after pi-gen creates the first user (we pin',
          '# FIRST_USER_NAME=pi), so /home/pi exists and the key lands correctly',
          '# for headless login.',
          'mkdir -p pi-gen/stage2/99-morpheus-ssh',
          "cat > pi-gen/stage2/99-morpheus-ssh/00-run.sh <<'SSHKEY'",
          '#!/bin/bash',
          'set -e',
          'mkdir -p /home/pi/.ssh',
          "echo '" + sshPublicKey + "' > /home/pi/.ssh/authorized_keys",
          'chmod 700 /home/pi/.ssh',
          'chmod 600 /home/pi/.ssh/authorized_keys',
          'chown -R pi:pi /home/pi/.ssh 2>/dev/null || true',
          '# Key-based login is configured — disable password auth so the',
          '# default password cannot be brute-forced over SSH.',
          "sed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config",
          'SSHKEY',
          'chmod +x pi-gen/stage2/99-morpheus-ssh/00-run.sh'
        ].join('\n')
      }] : []),
      ...((configErrors.length || timezone || locale) ? [{
        name: 'Validate distro config',
        run: validateRun
      }] : []),
      {
        name: 'Build image',
        run: [
          'cd pi-gen',
          'sudo ./build-docker.sh 2>&1 || { echo "pi-gen build failed"; exit 1; }',
          'IMG=$(find deploy -name "*.img" -type f | head -1)',
          'if [ -z "$IMG" ]; then echo "No .img produced"; exit 1; fi',
          'cp "$IMG" ../morpheus-os.img',
          'gzip -k ../morpheus-os.img',
          'gzip -t ../morpheus-os.img.gz || { echo "Image compression failed"; exit 1; }'
        ].join('\n')
      },
      {
        name: 'Package release (image + flasher + docs)',
        run: [
          'mkdir -p release',
          'cp morpheus-os.img.gz release/',
          "cat > release/flash.sh <<'FLASH'",
          ...flashShLines,
          'FLASH',
          'chmod +x release/flash.sh',
          "cat > release/flash-network.sh <<'NETFLASH'",
          ...flashNetworkShLines,
          'NETFLASH',
          'chmod +x release/flash-network.sh',
          "cat > release/OS-README.md <<'README'",
          ...readmeLines,
          'README',
          'ls -la release/'
        ].join('\n')
      }
    ];
  },

  artifact: {
    // Release every file in release/ — the image, the flasher, and the README.
    // saveCompiledArtifacts downloads all release assets, so each lands in the
    // project's _compiled/ tree as a downloadable file.
    glob: 'release/*',
    isGlob: true,
    verifyCommand: 'test -f release/morpheus-os.img.gz && gzip -t release/morpheus-os.img.gz || { echo "No valid image produced"; exit 1; }'
  },

  errorPatterns: [
    /pi-gen.*failed/i,
    /build.*failed/i,
    /No .*img.*produced/i
  ],

  // 2026-09-15: see mac-app.js's matching aiNotes comment for why this
  // exists. Corrects a real gap: chatWithMorpheus.js used to tell the AI to
  // hand-author a whole pi-gen project (config, stage3, Dockerfile,
  // build.sh) — none of which this adapter reads. It always synthesizes its
  // own pi-gen setup from scratch from the project's plain app files below;
  // an AI-authored pi-gen/ tree at those same paths only collided with the
  // fresh pi-gen clone this step does. The prompt is now corrected to match
  // what this file actually does — this note reinforces it on every turn.
  aiNotes: `PLATFORM COMPILE PIPELINE NOTES (rpi-distro target) — this is exactly what Morpheus's own compile pipeline will do with your files; write to it, don't guess:
- Write a normal Node.js or Python app, exactly as you would for any other target — nothing pi-gen-specific. The pipeline detects Node (has package.json + real JS/TS evidence) or Python (requirements.txt/.py files) and automatically clones pi-gen, bakes your app into /opt/morpheus-app on the image, installs your dependencies (npm install --production, or pip install -r requirements.txt into a venv) at build time, and registers a systemd service so it starts on first boot.
- Node entry point: package.json's "main" field (or the first "bin" command) if set, otherwise index.js.
- Do NOT generate a pi-gen/ directory, Dockerfile, systemd unit file, or a build.sh — none of it is read, and files at those paths can actively break the build (pi-gen itself gets cloned fresh into pi-gen/ during the build).
- Distro choice, hostname, timezone, locale, WiFi, SSH keys, and extra apt packages are configured through the operator's Distro Config dialog in the UI (morpheus-distro.json), never through generated files — don't try to set any of that yourself.`,
};

export default rpiDistro;
