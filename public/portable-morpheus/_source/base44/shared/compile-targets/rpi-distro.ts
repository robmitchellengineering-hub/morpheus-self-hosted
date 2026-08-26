// Raspberry Pi Distro compile target — produces a bootable .img.gz using pi-gen.
// Bundles the user's app onto the image and generates a first-boot systemd service.

import { CompileTarget, ProjectFile, BuildStep } from './types.ts';
import { isNodeProject, isPythonProject, detectPythonEntry, cloneFiles } from './utils.ts';

export const rpiDistro: CompileTarget = {
  id: 'rpi-distro',
  label: 'Raspberry Pi Distro',
  runner: 'ubuntu-latest',

  validate(files: ProjectFile[]) {
    // Always valid — pi-gen can build a minimal image even with no app
    return { valid: true, warnings: [] };
  },

  scaffold(files: ProjectFile[]) {
    return { files: cloneFiles(files), generated: [], warnings: [] };
  },

  buildSteps(files: ProjectFile[]): BuildStep[] {
    const isNode = isNodeProject(files);
    const isPython = isPythonProject(files);
    const pythonEntry = detectPythonEntry(files);

    // Build the package list based on the app's runtime
    const packages: string[] = [];
    if (isNode) packages.push('nodejs', 'npm');
    if (isPython) packages.push('python3', 'python3-pip');
    const pkgList = packages.length > 0 ? packages.join(' ') : '';

    // Generate the first-boot script that installs and runs the app
    const firstBootLines: string[] = [
      '#!/bin/bash',
      'set -e',
      'echo "Morpheus first-boot: installing app..."',
      'cd /opt/morpheus-app'
    ];
    if (isNode) {
      firstBootLines.push('npm install --production');
      firstBootLines.push('cat > /etc/systemd/system/morpheus-app.service <<UNIT');
      firstBootLines.push('[Unit]');
      firstBootLines.push('Description=Morpheus App');
      firstBootLines.push('After=network.target');
      firstBootLines.push('[Service]');
      firstBootLines.push('ExecStart=/usr/bin/node /opt/morpheus-app/index.js');
      firstBootLines.push('Restart=always');
      firstBootLines.push('[Install]');
      firstBootLines.push('WantedBy=multi-user.target');
      firstBootLines.push('UNIT');
    } else if (isPython) {
      firstBootLines.push('pip3 install -r requirements.txt 2>/dev/null || true');
      firstBootLines.push(`cat > /etc/systemd/system/morpheus-app.service <<UNIT`);
      firstBootLines.push('[Unit]');
      firstBootLines.push('Description=Morpheus App');
      firstBootLines.push('After=network.target');
      firstBootLines.push('[Service]');
      firstBootLines.push(`ExecStart=/usr/bin/python3 /opt/morpheus-app/${pythonEntry || 'main.py'}`);
      firstBootLines.push('Restart=always');
      firstBootLines.push('[Install]');
      firstBootLines.push('WantedBy=multi-user.target');
      firstBootLines.push('UNIT');
    }
    firstBootLines.push('systemctl daemon-reload');
    firstBootLines.push('systemctl enable morpheus-app');
    firstBootLines.push('systemctl start morpheus-app');
    firstBootLines.push('echo "Morpheus app installed and started."');

    return [
      { uses: 'actions/checkout@v4' },
      {
        name: 'Set up Docker',
        run: 'sudo apt-get update && sudo apt-get install -y docker.io quilt parted qemu-user-static debootstrap'
      },
      {
        name: 'Clone pi-gen',
        run: 'git clone --depth 1 https://github.com/RPi-Distro/pi-gen.git'
      },
      {
        name: 'Configure pi-gen',
        run: [
          'cd pi-gen',
          '# Use user config if present, otherwise create a minimal one',
          'if [ -f ../config ]; then cp ../config config; else',
          '  echo "IMG_NAME=morpheus-os" > config',
          '  echo "ENABLE_SSH=1" >> config',
          '  echo "STAGE_LIST=stage0 stage1 stage2" >> config',
          'fi',
          'touch stage3/SKIP stage4/SKIP stage5/SKIP 2>/dev/null || true'
        ].join('\n')
      },
      {
        name: 'Inject app into image',
        run: [
          '# Create a custom pi-gen stage that copies the app and installs deps',
          'mkdir -p pi-gen/stage2/01-install-app',
          'if [ -n "' + pkgList + '" ]; then',
          '  echo "' + pkgList + '" > pi-gen/stage2/01-install-app/00-packages',
          'fi',
          '# Copy app files into the image',
          'mkdir -p pi-gen/stage2/01-install-app/files/opt/morpheus-app',
          'cp -r ../. pi-gen/stage2/01-install-app/files/opt/morpheus-app/ 2>/dev/null || true',
          '# Create first-boot script',
          `cat > pi-gen/stage2/01-install-app/00-run.sh <<'FIRSTBOOT'`,
          ...firstBootLines,
          'FIRSTBOOT',
          'chmod +x pi-gen/stage2/01-install-app/00-run.sh'
        ].join('\n')
      },
      {
        name: 'Build image',
        run: [
          'cd pi-gen',
          'sudo ./build-docker.sh 2>&1 || { echo "pi-gen build failed"; exit 1; }',
          'IMG=$(find deploy -name "*.img" -type f | head -1)',
          'if [ -z "$IMG" ]; then echo "No .img produced"; exit 1; fi',
          'cp "$IMG" ../release.img',
          'ls -la ../release.img',
          '# Compress to save space',
          'gzip -k ../release.img',
          '# Verify the gzip is valid',
          'gzip -t ../release.img.gz || { echo "Image compression failed"; exit 1; }'
        ].join('\n')
      }
    ];
  },

  artifact: {
    glob: 'release.img.gz',
    isGlob: false,
    artifactName: 'morpheus-os.img.gz',
    verifyCommand: 'test -f release.img.gz && gzip -t release.img.gz || { echo "No valid image produced"; exit 1; }'
  },

  errorPatterns: [
    /pi-gen.*failed/i,
    /build.*failed/i,
    /No .*img.*produced/i
  ]
};

export default rpiDistro;