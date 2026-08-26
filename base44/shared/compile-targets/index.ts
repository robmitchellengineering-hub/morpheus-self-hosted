// Compile target adapter registry.
// compileProject looks up the adapter by target ID and delegates to it.
// To add a new target: create a new adapter file, import it here, add it to the registry.

import { CompileTarget } from './types.ts';
import webApp from './web-app.ts';
import androidApk from './android-apk.ts';
import pythonPackage from './python-package.ts';
import windowsExe from './windows-exe.ts';
import linuxBinary from './linux-binary.ts';
import macApp from './mac-app.ts';
import iosApp from './ios-app.ts';
import rpiDistro from './rpi-distro.ts';
import linuxDistro from './linux-distro.ts';
import arduinoFirmware from './arduino-firmware.ts';

const registry: Record<string, CompileTarget> = {
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
};

export function getCompileTarget(id: string): CompileTarget | null {
  return registry[id] || null;
}

export function listCompileTargets(): string[] {
  return Object.keys(registry);
}