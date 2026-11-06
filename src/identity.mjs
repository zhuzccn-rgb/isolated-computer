import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export function machineID() {
  let raw;
  if (process.platform === 'linux') raw = readFileSync('/etc/machine-id', 'utf8').trim();
  else if (process.platform === 'darwin') {
    const result = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' });
    raw = result.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1];
  } else if (process.platform === 'win32') {
    const result = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8' });
    raw = result.match(/MachineGuid\s+REG_SZ\s+(\S+)/)?.[1];
  }
  if (!raw) throw new Error('Cannot establish machine identity; desktop isolation cannot be verified');
  return createHash('sha256').update(raw.toLowerCase()).digest('hex');
}

export function assertIsolation(info, localID = machineID(), humanDisplay = process.env.DISPLAY) {
  if (typeof info.machineID !== 'string' || !info.machineID) throw new Error('Desktop bridge did not provide machine identity');
  const normalizeDisplay = display => display?.match(/^(?:(?:localhost|unix)?:)?:(\d+)(?:\.\d+)?$/)?.[1] ?? display;
  if (info.machineID !== localID && info.isolation?.kind === 'dedicated') return;
  if (process.platform === 'linux' && info.machineID === localID && info.isolation?.kind === 'xvfb' &&
      /^:\d+$/.test(info.isolation.display ?? '') && normalizeDisplay(info.isolation.display) !== normalizeDisplay(humanDisplay) && info.isolation.managed === true) return;
  throw new Error('Desktop is not isolated from this host. Use a managed Xvfb session or a separate VM/machine.');
}
