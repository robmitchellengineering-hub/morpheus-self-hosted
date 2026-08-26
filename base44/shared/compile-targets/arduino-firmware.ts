// Arduino Firmware compile target — compiles firmware using PlatformIO.
// Supports raw .ino projects (auto-generates platformio.ini) and multi-environment builds.

import { CompileTarget, ProjectFile, BuildStep } from './types.ts';
import { hasFile, hasPattern, cloneFiles, getFile, detectPythonVersion } from './utils.ts';

function detectBoard(files: ProjectFile[]): string | null {
  // Scan .ino files for board-specific includes
  for (const f of files) {
    if (!f.path.endsWith('.ino')) continue;
    if (/#include\s+[<"]ESP32/i.test(f.content)) return 'esp32dev';
    if (/#include\s+[<"]ESP8266/i.test(f.content)) return 'esp12e';
    if (/#include\s+[<"]Arduino\.h/i.test(f.content)) return 'uno';
  }
  return 'uno';
}

function detectPlatformioEnvs(content: string): string[] {
  const envs: string[] = [];
  const matches = content.matchAll(/\[env:([^\]]+)\]/g);
  for (const m of matches) {
    envs.push(m[1]);
  }
  return envs;
}

export const arduinoFirmware: CompileTarget = {
  id: 'arduino-firmware',
  label: 'Arduino Firmware',
  runner: 'ubuntu-latest',

  validate(files: ProjectFile[]) {
    const warnings: string[] = [];
    const hasPlatformio = hasFile(files, 'platformio.ini');
    const hasIno = hasPattern(files, /\.ino$/);

    if (!hasPlatformio && !hasIno) {
      return {
        valid: false,
        error: 'arduino-firmware target requires a platformio.ini or .ino source files.',
        warnings
      };
    }
    if (!hasPlatformio && hasIno) {
      warnings.push('No platformio.ini found — will auto-generate one from .ino source files.');
    }
    return { valid: true, warnings };
  },

  scaffold(files: ProjectFile[]) {
    const generated: string[] = [];
    const warnings: string[] = [];
    const augmented = cloneFiles(files);

    // Auto-generate platformio.ini from .ino files if missing
    if (!hasFile(augmented, 'platformio.ini') && hasPattern(augmented, /\.ino$/)) {
      const board = detectBoard(augmented);
      const boardUrls: Record<string, string> = {
        'esp32dev': 'http://arduino.esp32.com/stable/package_esp32_index.json',
        'esp12e': 'http://arduino.esp8266.com/stable/package_esp8266com_index.json',
        'uno': ''
      };

      const lines: string[] = [
        '[platformio]',
        'default_envs = default',
        ''
      ];

      if (boardUrls[board]) {
        lines.push(`boards_dir = ${boardUrls[board]}`);
      }

      lines.push(
        '',
        '[env:default]',
        `platform = ${board === 'esp32dev' ? 'espressif32' : board === 'esp12e' ? 'espressif8266' : 'atmelavr'}`,
        `board = ${board}`,
        'framework = arduino',
        'monitor_speed = 115200'
      );

      augmented.push({ path: 'platformio.ini', content: lines.join('\n') + '\n' });
      generated.push('platformio.ini');
      warnings.push(`Auto-generated platformio.ini (board: ${board}).`);
    }

    return { files: augmented, generated, warnings };
  },

  buildSteps(files: ProjectFile[]): BuildStep[] {
    // Check if platformio.ini has multiple environments
    const pioContent = getFile(files, 'platformio.ini')?.content || '';
    const envs = detectPlatformioEnvs(pioContent);
    const buildCommand = envs.length > 1
      ? `pio run -e ${envs.join(' -e ')}`
      : 'pio run';
    const pythonVersion = detectPythonVersion(files) || '3.12';

    return [
      { uses: 'actions/checkout@v4' },
      {
        uses: 'actions/setup-python@v5',
        with: { 'python-version': `'${pythonVersion}'` }
      },
      {
        name: 'Cache pip',
        uses: 'actions/cache@v4',
        with: {
          path: '~/.cache/pip',
          key: "pip-${{ runner.os }}-${{ hashFiles('platformio.ini') }}",
          'restore-keys': 'pip-${{ runner.os }}-'
        }
      },
      { run: 'pip install platformio' },
      {
        name: 'Resolve libraries',
        run: 'pio pkg install -e default 2>/dev/null || pio lib install 2>/dev/null || true'
      },
      {
        name: 'Build firmware',
        run: [
          `${buildCommand} || { echo "PlatformIO build failed"; exit 1; }`,
          '# Collect firmware artifacts (.hex for AVR, .bin for ARM)',
          'FIRMWARE=$(find .pio -name "firmware.hex" -o -name "firmware.bin" | head -1)',
          'if [ -z "$FIRMWARE" ]; then echo "No firmware produced"; exit 1; fi',
          'cp "$FIRMWARE" release_firmware',
          '# Also grab the ELF for debugging',
          'ELF=$(find .pio -name "firmware.elf" | head -1)',
          'if [ -n "$ELF" ]; then cp "$ELF" release_firmware.elf; fi',
          'ls -la release_firmware*'
        ].join('\n')
      }
    ];
  },

  artifact: {
    glob: 'release_firmware*',
    isGlob: true,
    verifyCommand: 'test -f release_firmware || { echo "No firmware produced"; exit 1; }'
  },

  errorPatterns: [
    /error:/i,
    /BUILD FAILED/i,
    /platformio.*failed/i,
    /No firmware/i,
    /Library not found/i
  ]
};

export default arduinoFirmware;