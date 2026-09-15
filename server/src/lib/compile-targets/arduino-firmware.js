// Arduino Firmware compile target — compiles firmware using PlatformIO.
// Supports raw .ino projects (auto-generates platformio.ini) and multi-environment builds.

import { hasFile, hasPattern, cloneFiles, getFile, detectPythonVersion } from './utils.js';

// Board detection now scans .h/.cpp files too, not just the top-level .ino —
// the AI prompt for this target explicitly encourages "split into multiple
// .ino/.cpp/.h files with clear module boundaries" for larger sketches, and
// board-identifying includes (WiFi.h, BluetoothSerial.h, etc.) commonly live
// in a module file, not the thin top-level .ino that just ties them
// together. Scanning only .ino meant a real modular ESP32/ESP8266 project
// silently fell back to 'uno'/atmelavr and failed to compile against
// ESP-only APIs.
const SKETCH_EXT = /\.(ino|cpp|c|h|hpp)$/i;

// ESP32: bare WiFi.h is a real, fairly reliable signal — ESP8266's Arduino
// core ships its WiFi support as ESP8266WiFi.h, never a bare WiFi.h, so this
// doesn't collide with the ESP8266 case below. BluetoothSerial/esp_now/
// esp32-hal/Preferences are all ESP32-exclusive APIs.
const ESP32_SIGNALS = /#include\s+[<"](ESP32|WiFi\.h|BluetoothSerial|esp_now|esp32-hal|Preferences\.h)/i;
const ESP8266_SIGNALS = /#include\s+[<"](ESP8266)/i;
// Mega-exclusive hardware: Serial1/2/3 don't exist on an Uno. No reliable
// code signal distinguishes a Nano from an Uno (same MCU, same single
// Serial) — left undetected rather than guessed.
const MEGA_SIGNALS = /\bSerial[123]\b/;

function detectBoard(files) {
  const sketchFiles = files.filter((f) => SKETCH_EXT.test(f.path));
  for (const f of sketchFiles) {
    if (ESP32_SIGNALS.test(f.content)) return 'esp32dev';
    if (ESP8266_SIGNALS.test(f.content)) return 'esp12e';
  }
  for (const f of sketchFiles) {
    if (MEGA_SIGNALS.test(f.content)) return 'megaatmega2560';
  }
  return 'uno';
}

// PlatformIO expects sources under src/ by default; an AI-generated sketch
// (per the prompt, "a .ino file with setup() and loop()", no mention of a
// src/ layout) normally lands at the repo root instead, giving PlatformIO
// nothing to build ("Nothing to build. Please put your source code files
// into ... 'src' folder"). Detect wherever the actual sketch files live and
// point src_dir at that real location instead of assuming src/ exists.
// Returns null when sketch files are split across multiple directories (no
// single correct answer — falls back to PlatformIO's own default).
function detectSrcDir(files) {
  const sketchFiles = files.filter((f) => SKETCH_EXT.test(f.path));
  if (sketchFiles.length === 0) return null;
  const dirs = new Set(sketchFiles.map((f) => (f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '.')));
  return dirs.size === 1 ? [...dirs][0] : null;
}

function detectPlatformioEnvs(content) {
  const envs = [];
  const matches = content.matchAll(/\[env:([^\]]+)\]/g);
  for (const m of matches) {
    envs.push(m[1]);
  }
  return envs;
}

export const arduinoFirmware = {
  id: 'arduino-firmware',
  label: 'Arduino Firmware',
  runner: 'ubuntu-latest',

  validate(files) {
    const warnings = [];
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

  scaffold(files) {
    const generated = [];
    const warnings = [];
    const augmented = cloneFiles(files);

    // Auto-generate platformio.ini from .ino files if missing
    if (!hasFile(augmented, 'platformio.ini') && hasPattern(augmented, /\.ino$/)) {
      const board = detectBoard(augmented);
      const srcDir = detectSrcDir(augmented);

      const lines = [
        '[platformio]',
        'default_envs = default',
      ];
      // Only set src_dir when every sketch file shares one real directory —
      // a mixed/ambiguous layout falls back to PlatformIO's own default
      // (src/) rather than guessing wrong.
      if (srcDir) lines.push(`src_dir = ${srcDir}`);
      lines.push('');

      lines.push(
        '[env:default]',
        `platform = ${board === 'esp32dev' ? 'espressif32' : board === 'esp12e' ? 'espressif8266' : 'atmelavr'}`, // uno and megaatmega2560 are both AVR
        `board = ${board}`,
        'framework = arduino',
        'monitor_speed = 115200'
      );
      // Board-package board definitions (espressif32/espressif8266/atmelavr)
      // already ship the board JSON for esp32dev/esp12e/uno/megaatmega2560 —
      // no boards_dir override needed. (Previously pointed boards_dir, a
      // PlatformIO *local filesystem path* setting, at an Arduino-IDE-style
      // "Additional Board Manager URL" — two different ecosystems' concepts
      // of "board URL" conflated; at best a no-op, not a real fix for an
      // unlisted board.)

      augmented.push({ path: 'platformio.ini', content: lines.join('\n') + '\n' });
      generated.push('platformio.ini');
      warnings.push(`Auto-generated platformio.ini (board: ${board}${srcDir ? `, src_dir: ${srcDir}` : ''}).`);
    }

    return { files: augmented, generated, warnings };
  },

  buildSteps(files) {
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
        // No -e flag: operates on every environment platformio.ini actually
        // defines. The previous hardcoded `-e default` matched only this
        // adapter's own auto-generated config — an AI-authored
        // platformio.ini with a custom environment name (which the prompt
        // explicitly permits) silently failed this step and fell back to
        // the weaker generic `pio lib install`.
        run: 'pio pkg install 2>/dev/null || pio lib install 2>/dev/null || true'
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
