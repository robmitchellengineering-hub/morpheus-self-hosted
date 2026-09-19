// Full Linux distro compile target — produces a bootable x86_64 disk image using
// mkosi (systemd's bespoke OS image builder). Supports popular editable distros
// (Debian, Ubuntu, Fedora) for PC and server builds. The app and its deps are
// baked into the image at build time (installed inside the image by the postinst
// script, so they're linked against the target's glibc) and start on first boot
// via systemd.
//
// The release bundles a flash.sh disk writer (USB / hard drive / VM disk), a
// network flasher (push over SSH to a remote server), and a README — mirroring
// the Raspberry Pi distro pipeline so the two flows stay consistent.

import { isNodeProject, isPythonProject, detectPythonEntry, detectNodeEntry } from './utils.js';

// Read the optional morpheus-linux-distro.json from the project file tree — the
// UI (LinuxDistroConfigDialog) writes this so users can customise the image
// without hand-editing mkosi config. Returns null if absent or unparseable.
function readDistroConfig(files) {
  const f = files.find(x => x.path === 'morpheus-linux-distro.json' || x.path.endsWith('/morpheus-linux-distro.json'));
  if (!f || !f.content) return null;
  try { return JSON.parse(f.content); } catch { return null; }
}

// Per-base distro mapping. Keeping every distro-specific value in one place lets
// the adapter generate a correct mkosi.conf for each base:
//   - kernel: the package that provides the bootable kernel (+ modules)
//   - bootloader: UEFI grub packages — `Bootloader=grub` in current mkosi builds
//     a UEFI grub image, so we install the EFI grub binaries (NOT grub-pc/BIOS)
//   - initrd: the initramfs generator mkosi invokes for `Bootable=yes`
//   - sudoGroup: sudo/wheel membership for the first user
//   - repositories: apt components (Ubuntu needs `universe` for npm; Fedora omits)
//   - basePackages: init, ssh, locale support every image needs
const BASES = {
  // Bootloader = signed grub + shim so images boot under UEFI Secure Boot
  // (most modern servers ship with SB enabled). -bin provides grub modules.
  'debian-bookworm': { distro: 'debian', release: 'bookworm', kernel: 'linux-image-amd64', bootloader: ['grub-efi-amd64-signed', 'grub-efi-amd64-bin', 'shim-signed'], initrd: ['initramfs-tools'], sudoGroup: 'sudo', repositories: 'main,contrib,non-free,non-free-firmware', basePackages: ['systemd', 'systemd-sysv', 'sudo', 'openssh-server', 'locales', 'ca-certificates'] },
  'debian-trixie':   { distro: 'debian', release: 'trixie',  kernel: 'linux-image-amd64', bootloader: ['grub-efi-amd64-signed', 'grub-efi-amd64-bin', 'shim-signed'], initrd: ['initramfs-tools'], sudoGroup: 'sudo', repositories: 'main,contrib,non-free', basePackages: ['systemd', 'systemd-sysv', 'sudo', 'openssh-server', 'locales', 'ca-certificates'] },
  'ubuntu-noble':    { distro: 'ubuntu', release: 'noble',   kernel: 'linux-image-generic', bootloader: ['grub-efi-amd64-signed', 'grub-efi-amd64-bin', 'shim-signed'], initrd: ['initramfs-tools'], sudoGroup: 'sudo', repositories: 'main,universe,restricted,multiverse', basePackages: ['systemd', 'systemd-sysv', 'sudo', 'openssh-server', 'locales', 'ca-certificates'] },
  'ubuntu-jammy':    { distro: 'ubuntu', release: 'jammy',   kernel: 'linux-image-generic', bootloader: ['grub-efi-amd64-signed', 'grub-efi-amd64-bin', 'shim-signed'], initrd: ['initramfs-tools'], sudoGroup: 'sudo', repositories: 'main,universe,restricted,multiverse', basePackages: ['systemd', 'systemd-sysv', 'sudo', 'openssh-server', 'locales', 'ca-certificates'] },
  'fedora-43':       { distro: 'fedora', release: '43',      kernel: 'kernel', bootloader: ['grub2-efi-x64', 'shim-x64'], initrd: ['dracut', 'dracut-config-generic'], sudoGroup: 'wheel', repositories: '', basePackages: ['systemd', 'sudo', 'openssh-server', 'glibc-langpack-en', 'ca-certificates'] },
  'fedora-44':       { distro: 'fedora', release: '44',      kernel: 'kernel', bootloader: ['grub2-efi-x64', 'shim-x64'], initrd: ['dracut', 'dracut-config-generic'], sudoGroup: 'wheel', repositories: '', basePackages: ['systemd', 'sudo', 'openssh-server', 'glibc-langpack-en', 'ca-certificates'] },
};

export const linuxDistro = {
  id: 'linux-distro',
  label: 'Linux Distro (PC/Server)',
  runner: 'ubuntu-latest',

  validate(files) {
    // Always valid — mkosi can build a minimal image even with no app
    return { valid: true, warnings: [] };
  },

  scaffold(files) {
    return { files: [...files], generated: [], warnings: [] };
  },

  buildSteps(files) {
    const isNode = isNodeProject(files);
    const isPython = isPythonProject(files);
    const pythonEntry = detectPythonEntry(files);

    const cfg = readDistroConfig(files) || {};
    const baseKey = cfg.base && BASES[cfg.base] ? cfg.base : 'debian-bookworm';
    const base = BASES[baseKey];
    const hostname = cfg.hostname || '';
    const timezone = cfg.timezone || '';
    const locale = cfg.locale || '';
    const firstUser = (cfg.firstUser || 'morpheus').trim();
    const firstUserPass = cfg.firstUserPass || 'morpheus';
    const sshEnabled = cfg.sshEnabled !== false;
    const sshPublicKey = cfg.sshPublicKey || '';
    const extraPackages = Array.isArray(cfg.extraPackages) ? cfg.extraPackages.filter(p => typeof p === 'string' && p.trim()) : [];
    const extraRunCommands = Array.isArray(cfg.extraRunCommands) ? cfg.extraRunCommands.filter(c => typeof c === 'string' && c.trim()) : [];

    // mkosi.conf [Content] Packages — base + kernel + bootloader + initrd +
    // app runtime + user extras. mkosi installs these into the image.
    const packages = new Set([...base.basePackages, ...base.initrd, ...base.bootloader]);
    packages.add(base.kernel);
    if (isNode) {
      packages.add('nodejs');
      // Debian/Ubuntu ship npm separately; Fedora's nodejs bundles it.
      if (base.distro !== 'fedora') packages.add('npm');
    }
    if (isPython) {
      packages.add('python3');
      // Debian/Ubuntu need python3-venv for `python3 -m venv`; Fedora's python3
      // already includes venv + pip.
      if (base.distro !== 'fedora') packages.add('python3-venv');
    }
    for (const p of extraPackages) packages.add(p);
    const pkgList = Array.from(packages).join(', ');

    // mkosi.postinst — runs inside the image root (in the build context, which
    // has network) after packages are installed. Installs app deps against the
    // target's glibc, creates the first user, configures hostname/timezone/
    // locale/SSH, registers the systemd service, and runs custom commands.
    const postinst = [
      '#!/bin/sh',
      'set -e',
      'cd /opt/morpheus-app'
    ];

    // App dependencies — Python uses an isolated venv (avoids PEP 668
    // "externally-managed-environment" errors on newer distros); Node uses npm.
    //
    // No `|| true` on either: swallowing a dependency-install failure builds a
    // green image whose app cannot start, which is worse than a red build —
    // the operator finds out from a crash-looping device instead of the log.
    if (isNode) postinst.push('npm install --production');
    if (isPython) {
      postinst.push('python3 -m venv /opt/morpheus-app/.venv');
      postinst.push('/opt/morpheus-app/.venv/bin/pip install -r /opt/morpheus-app/requirements.txt');
    }

    // systemd service so the app starts on first boot (no network needed).
    if (isNode || isPython) {
      if (isNode) {
        postinst.push('cat > /etc/systemd/system/morpheus-app.service <<UNIT');
        postinst.push('[Unit]');
        postinst.push('Description=Morpheus App');
        postinst.push('After=network.target');
        postinst.push('[Service]');
        postinst.push('ExecStart=/usr/bin/node /opt/morpheus-app/' + detectNodeEntry(files));
        postinst.push('WorkingDirectory=/opt/morpheus-app');
        postinst.push('Restart=always');
        postinst.push('[Install]');
        postinst.push('WantedBy=multi-user.target');
        postinst.push('UNIT');
      } else {
        const entry = pythonEntry || 'main.py';
        postinst.push('cat > /etc/systemd/system/morpheus-app.service <<UNIT');
        postinst.push('[Unit]');
        postinst.push('Description=Morpheus App');
        postinst.push('After=network.target');
        postinst.push('[Service]');
        postinst.push('ExecStart=/opt/morpheus-app/.venv/bin/python /opt/morpheus-app/' + entry);
        postinst.push('WorkingDirectory=/opt/morpheus-app');
        postinst.push('Restart=always');
        postinst.push('[Install]');
        postinst.push('WantedBy=multi-user.target');
        postinst.push('UNIT');
      }
      // Enable manually — systemctl is unreliable in a chroot with no init.
      postinst.push('mkdir -p /etc/systemd/system/multi-user.target.wants');
      postinst.push('ln -sf /etc/systemd/system/morpheus-app.service /etc/systemd/system/multi-user.target.wants/morpheus-app.service');
    }

    // First user + password + sudo group membership.
    postinst.push('useradd -m -s /bin/bash ' + firstUser + ' 2>/dev/null || true');
    postinst.push('echo "' + firstUser + ':' + firstUserPass + '" | chpasswd');
    postinst.push('usermod -aG ' + base.sudoGroup + ' ' + firstUser + ' 2>/dev/null || true');

    // Hostname: set /etc/hostname AND the 127.0.1.1 line in /etc/hosts so the
    // hostname and name resolution agree (otherwise `hostname` and `sudo` warn).
    if (hostname) {
      postinst.push('echo "' + hostname + '" > /etc/hostname');
      // Replace the 127.0.1.1 line if present (Debian/Ubuntu add one by default),
      // otherwise append it (Fedora has no 127.0.1.1 line). sed returns 0 even on
      // no match, so a plain `|| echo` would never fire — use an explicit guard.
      postinst.push('if grep -q "^127\\.0\\.1\\.1" /etc/hosts; then sed -i "s|^127\\.0\\.1\\.1.*|127.0.1.1\\t' + hostname + '|" /etc/hosts; else echo "127.0.1.1\\t' + hostname + '" >> /etc/hosts; fi');
    }
    if (timezone) {
      postinst.push('ln -sf /usr/share/zoneinfo/' + timezone + ' /etc/localtime');
    }
    // Locale: Debian/Ubuntu use locale-gen; Fedora uses localectl + langpacks.
    if (locale) {
      if (base.distro === 'fedora') {
        // localectl needs a running systemd (absent in the build chroot), so
        // write /etc/locale.conf directly — Fedora reads it on boot.
        postinst.push('echo "LANG=' + locale + '" > /etc/locale.conf');
      } else {
        postinst.push('echo "' + locale + ' UTF-8" >> /etc/locale.gen');
        postinst.push('locale-gen');
        postinst.push('echo "LANG=' + locale + '" > /etc/default/locale');
      }
    }

    // SSH: enable the service via manual symlinks (works in a chroot). If a key
    // is provided, inject it and disable password login so the default password
    // cannot be brute-forced.
    if (sshEnabled) {
      // Enable the SSH unit via manual symlinks (systemctl is unreliable in a
      // chroot). Handle .service (Debian/Ubuntu ssh.service, Fedora sshd) and
      // .socket (Fedora 41+ ships socket-activated sshd.socket).
      postinst.push('mkdir -p /etc/systemd/system/multi-user.target.wants /etc/systemd/system/sockets.target.wants');
      postinst.push('for svc in ssh sshd; do if [ -f /lib/systemd/system/$svc.service ]; then ln -sf /lib/systemd/system/$svc.service /etc/systemd/system/multi-user.target.wants/$svc.service; fi; done');
      postinst.push('for svc in ssh sshd; do if [ -f /lib/systemd/system/$svc.socket ]; then ln -sf /lib/systemd/system/$svc.socket /etc/systemd/system/sockets.target.wants/$svc.socket; fi; done');
      if (sshPublicKey) {
        postinst.push('mkdir -p /home/' + firstUser + '/.ssh');
        postinst.push("echo '" + sshPublicKey + "' > /home/" + firstUser + '/.ssh/authorized_keys');
        postinst.push('chmod 700 /home/' + firstUser + '/.ssh');
        postinst.push('chmod 600 /home/' + firstUser + '/.ssh/authorized_keys');
        postinst.push('chown -R ' + firstUser + ':' + firstUser + ' /home/' + firstUser + '/.ssh 2>/dev/null || true');
        postinst.push("sed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config");
      }
    } else {
      postinst.push('rm -f /etc/systemd/system/multi-user.target.wants/ssh.service /etc/systemd/system/multi-user.target.wants/sshd.service');
    }

    // Lock root — the first user (with sudo) is the login account.
    postinst.push('passwd -l root 2>/dev/null || true');

    // Custom commands run in a subshell with `|| echo` so one failing line
    // logs the error but does NOT abort the whole mkosi build (set -e above).
    for (const cmd of extraRunCommands) {
      postinst.push('( ' + cmd + ' ) 2>&1 || echo "MORPHEUS: a custom run command failed (non-fatal), continuing..."');
    }

    // mkosi.conf — declarative image definition. `Bootloader=grub` in current
    // mkosi builds a UEFI grub image, so the result boots on modern PC/server
    // firmware (UEFI) and as a VM disk. mkosi creates the EFI System Partition
    // automatically when Bootable=yes + a UEFI bootloader is configured.
    const mkosiConfLines = [
      '[Distribution]',
      'Distribution=' + base.distro,
      'Release=' + base.release,
      'Architecture=x86-64'
    ];
    if (base.repositories) mkosiConfLines.push('Repositories=' + base.repositories);
    mkosiConfLines.push('', '[Output]', 'Format=disk', 'Output=morpheus-os.img', '', '[Content]', 'Packages=' + pkgList, 'Bootable=yes', 'Bootloader=grub', '');
    const mkosiConf = mkosiConfLines.join('\n');

    // Pre-build validation of distro config. Format + shell-safety checks run in
    // JS (so a raw config override with an unsafe value can't inject into the
    // generated shell); the timezone existence check runs against runner tzdata.
    const RE_PASS = /^[A-Za-z0-9]{1,40}$/;
    const RE_HOSTNAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
    const RE_TZ = /^[A-Za-z0-9_/+-]+\/[A-Za-z0-9_/+-]+$/;
    const RE_LOCALE = /^[a-z]{2}_[A-Z]{2}\.UTF-8$/;
    const RE_USER = /^[a-z][a-z0-9_-]{0,31}$/;
    const configErrors = [];
    if (firstUserPass && !RE_PASS.test(firstUserPass)) configErrors.push('firstUserPass must be alphanumeric (1-40 chars)');
    if (hostname && !RE_HOSTNAME.test(hostname)) configErrors.push('hostname must be lowercase alphanumeric + hyphens (max 63)');
    if (timezone && !RE_TZ.test(timezone)) configErrors.push('timezone must be in Area/City form (e.g. Australia/Sydney)');
    if (locale && !RE_LOCALE.test(locale)) configErrors.push('locale must be in the form xx_XX.UTF-8');
    if (!RE_USER.test(firstUser)) configErrors.push('firstUser must start with a lowercase letter (lowercase, digits, _ -, max 32)');
    const validateRunLines = ['echo "Validating morpheus-linux-distro.json config..."'];
    for (const e of configErrors) validateRunLines.push('echo "ERROR: ' + e + '"');
    if (configErrors.length) {
      validateRunLines.push('exit 1');
    } else {
      if (timezone) validateRunLines.push('test -f /usr/share/zoneinfo/' + timezone + ' || { echo "ERROR: invalid timezone: ' + timezone + ' — not found in tzdata"; exit 1; }');
    }
    const validateRun = validateRunLines.join('\n');

    // flash.sh — writes morpheus-os.img.gz to a disk (USB / hard drive / VM
    // disk) on Linux + macOS. The image is UEFI-bootable.
    const flashShLines = [
      '#!/bin/bash',
      '# Morpheus OS flasher — writes morpheus-os.img.gz to a disk (USB, hard',
      '# drive, or VM disk image). UEFI-bootable; boots on modern PC/server.',
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
      'echo "Done. Boot from $DEV (UEFI) — your app starts automatically via the morpheus-app service."'
    ];

    // flash-network.sh — pushes the image over SSH to a remote server and
    // writes it to a block device there (no physical disk swapping).
    const flashNetworkShLines = [
      '#!/bin/bash',
      '# Morpheus OS network flasher — pushes the image over SSH to a remote',
      '# server and writes it to a block device there. The remote must be',
      '# reachable via SSH and have sudo.',
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
      'echo "Done. Image written to $DEST:$DEV. Reboot the remote to boot from it (UEFI)."'
    ];

    // OS-README.md — flashing instructions for every platform.
    const readmeLines = [
      '# Morpheus OS — ' + base.distro + ' ' + base.release + ' (x86_64, UEFI)',
      '',
      'A bootable Linux disk image with your app baked in and running on first boot.',
      'Built with [mkosi](https://github.com/systemd/mkosi). UEFI-bootable — boots on',
      'modern PC and server firmware and as a VM disk image.',
      '',
      '## Contents',
      '- `morpheus-os.img.gz` — bootable disk image (compressed)',
      '- `flash.sh` — local disk flasher (Linux / macOS)',
      '- `flash-network.sh` — network flasher (push over SSH to a remote server)',
      '- `OS-README.md` — this file',
      '',
      '## Flash to disk',
      '',
      '### Linux / macOS (flash.sh)',
      '```bash',
      'sudo ./flash.sh /dev/sdX      # Linux',
      'sudo ./flash.sh /dev/rdiskN    # macOS (use rdiskN, not diskN)',
      '```',
      'Run `sudo ./flash.sh` with no argument to list available disks first.',
      '',
      '### Over the network (flash-network.sh)',
      'Push the image to a remote server already on your network and write it in place:',
      '```bash',
      './flash-network.sh morpheus@192.168.1.50 /dev/sda',
      '```',
      'The remote host needs SSH access and sudo. The image is decompressed and',
      'piped straight to `dd` on the remote block device — no disk swapping.',
      '',
      '### As a VM disk',
      'Attach `morpheus-os.img` (decompress first: `gunzip morpheus-os.img.gz`) as',
      'a hard drive in QEMU / VirtualBox / VMware / Proxmox. Boot the VM with UEFI',
      'firmware (the image is not BIOS-bootable).',
      '',
      '### Windows',
      'Use [Rufus](https://rufus.ie/) or [balenaEtcher](https://etcher.balena.io/):',
      'select `morpheus-os.img.gz` → pick your USB drive → Write (UEFI mode).',
      '',
      '## First boot',
      sshEnabled
        ? '- SSH is enabled. Login: `' + firstUser + '` / password: `' + firstUserPass + '` — **change it on first boot** with `passwd`.'
        : '- SSH is disabled. Re-flash with SSH enabled in the distro config to log in headlessly.',
      ...(sshPublicKey && sshEnabled ? ['- SSH key login is configured for the `' + firstUser + '` user (password login disabled).'] : []),
      '- `' + firstUser + '` is a member of the `' + base.sudoGroup + '` group (sudo access).',
      '- Root login is disabled.',
      '- **UEFI boot**: boots on modern UEFI firmware. If Secure Boot is enabled and the image won\'t boot, disable Secure Boot in the firmware settings.',
      '- Your app starts automatically via the `morpheus-app` systemd service.',
      '',
      '```',
      'journalctl -u morpheus-app -f     # app logs',
      'systemctl status morpheus-app     # service status',
      '```'
    ];

    return [
      { uses: 'actions/checkout@v4' },
      {
        name: 'Install mkosi and build deps',
        run: [
          'sudo apt-get update',
          'sudo apt-get install -y debootstrap dnf systemd-container squashfs-tools dosfstools mtools xorriso bubblewrap python3-pip python3-venv',
          '# mkosi from git guarantees a recent v16+ build (distro packages are often older)',
          'sudo pip3 install --break-system-packages git+https://github.com/systemd/mkosi.git',
          'mkosi --version'
        ].join('\n')
      },
      {
        name: 'Write mkosi config and bake app into image root',
        run: [
          "cat > mkosi.conf <<'EOF'",
          mkosiConf,
          'EOF',
          "cat > mkosi.postinst <<'POSTINST'",
          ...postinst,
          'POSTINST',
          'chmod +x mkosi.postinst',
          '# mkosi copies mkosi.extra/ into the image root — put the app there.',
          '# Archive the repo root (the workflow runs here) so the app lands at',
          '# /opt/morpheus-app/ (NOT nested under the repo folder). node_modules',
          '# is excluded — the postinst reinstalls deps inside the image against',
          '# the target glibc.',
          'mkdir -p mkosi.extra/opt/morpheus-app',
          'tar --exclude="./mkosi.conf" --exclude="./mkosi.postinst" --exclude="./mkosi.extra" --exclude="./mkosi.output" --exclude="./mkosi.cache" --exclude="./release" --exclude="./.git" --exclude="./node_modules" -cf - . | tar -xf - -C mkosi.extra/opt/morpheus-app/'
        ].join('\n')
      },
      ...((configErrors.length || timezone) ? [{
        name: 'Validate distro config',
        run: validateRun
      }] : []),
      {
        name: 'Build image with mkosi',
        run: [
          'sudo mkosi --force 2>&1 || { echo "mkosi build failed"; exit 1; }',
          '# mkosi run as sudo → output is root-owned; chown so the runner can',
          '# read/compress it without sudo.',
          'sudo chown -R $(id -u):$(id -g) mkosi.output 2>/dev/null || true',
          '# mkosi writes to ./mkosi.output/ by default (or cwd). Locate the image.',
          'IMG=',
          'for cand in mkosi.output/morpheus-os.img morpheus-os.img; do if [ -f "$cand" ]; then IMG="$cand"; break; fi; done',
          'if [ -z "$IMG" ]; then echo "No .img produced by mkosi"; exit 1; fi',
          'if [ "$IMG" != "morpheus-os.img" ]; then cp "$IMG" morpheus-os.img; fi',
          'gzip -k morpheus-os.img',
          'gzip -t morpheus-os.img.gz || { echo "Image compression failed"; exit 1; }'
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
    glob: 'release/*',
    isGlob: true,
    verifyCommand: 'test -f release/morpheus-os.img.gz && gzip -t release/morpheus-os.img.gz || { echo "No valid image produced"; exit 1; }'
  },

  errorPatterns: [
    /mkosi.*failed/i,
    /build.*failed/i,
    /No .*img.*produced/i
  ],

  // 2026-09-15: see mac-app.js's matching aiNotes comment for why this
  // exists. This target previously had NO entry at all in
  // BUILD_TARGET_INSTRUCTIONS — the AI had zero guidance on what this
  // adapter actually does and would improvise (a Dockerfile, packaging
  // scripts, OS-build tooling) based on general knowledge, none of which is
  // read here. The prompt now has a real section for this target; this note
  // reinforces it on every turn straight from the adapter itself.
  aiNotes: `PLATFORM COMPILE PIPELINE NOTES (linux-distro target) — this is exactly what Morpheus's own compile pipeline will do with your files; write to it, don't guess:
- Write a normal Node.js or Python app, exactly as you would for any other target — nothing OS-image-specific. The pipeline detects Node (has package.json + real JS/TS evidence) or Python (requirements.txt/.py files) and automatically bakes your app into /opt/morpheus-app on a bootable Debian/Ubuntu/Fedora disk image (built with mkosi), installs your dependencies at build time, and registers a systemd service so it starts on first boot.
- Node entry point: package.json's "main" field (or the first "bin" command) if set, otherwise index.js.
- Do NOT generate a Dockerfile, mkosi config, systemd unit file, or any ISO/Yocto/Buildroot-style OS-build scaffolding — none of it is read.
- Base distro, hostname, timezone, locale, first user, SSH, and extra packages are configured through the operator's Linux Distro Config dialog in the UI, never through generated files — don't try to set any of that yourself.`,
};

export default linuxDistro;
