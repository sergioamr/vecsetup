// Picks the laptop address the robot should download from.
import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Parse `ip route get <dst>` output, e.g. "192.168.0.239 dev wlp3s0 src 192.168.0.208 uid 1000". */
export function parseRouteSrc(output: string): string | null {
  const m = output.match(/\bsrc\s+(\d{1,3}(?:\.\d{1,3}){3})\b/);
  return m ? m[1] : null;
}

/** Local IPv4 used to reach `robotIp`; falls back to the first non-internal IPv4. */
export async function localAddressFor(robotIp: string | null): Promise<string> {
  if (robotIp) {
    try {
      const { stdout } = await run('ip', ['-4', 'route', 'get', robotIp]);
      const src = parseRouteSrc(stdout);
      if (src) return src;
    } catch { /* fall through */ }
  }
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  throw new Error('no IPv4 address found to serve the OTA from');
}
