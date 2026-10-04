// Compile target adapter registry.
// compileProject looks up the adapter by target ID and delegates to it.
// To add a new target: create a new adapter file, import it here, add it to the registry.

import webApp from './web-app.js';
import androidApk from './android-apk.js';
import pythonPackage from './python-package.js';
import windowsExe from './windows-exe.js';
import linuxBinary from './linux-binary.js';
import macApp from './mac-app.js';
import iosApp from './ios-app.js';
import rpiDistro from './rpi-distro.js';
import linuxDistro from './linux-distro.js';
import arduinoFirmware from './arduino-firmware.js';
import audioPlugin from './audio-plugin.js';

const registry = {
  'web-app': webApp,
  'android-apk': androidApk,
  'python-package': pythonPackage,
  'windows-exe': windowsExe,
  'linux-binary': linuxBinary,
  'mac-app': macApp,
  'ios-app': iosApp,
  'rpi-distro': rpiDistro,
  'linux-distro': linuxDistro,
  'arduino-firmware': arduinoFirmware,
  'audio-plugin': audioPlugin,
};

export function getCompileTarget(id) {
  return registry[id] || null;
}

export function listCompileTargets() {
  return Object.keys(registry);
}
