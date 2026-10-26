// Checks the Linux Bluetooth setup for the problems that break Vector pairing.
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
export type Check = { name: string; ok: boolean | null; detail: string; fix?: string };

// BlueZ default is 42 (420 ms). Vector needs longer while its link settles.
export const RECOMMENDED_SUPERVISION_TIMEOUT = 500; // units of 10 ms = 5 s

/** Read `[LE] ConnectionSupervisionTimeout` from a BlueZ main.conf. */
export function parseSupervisionTimeout(conf: string): number | null {
  let inLE = false;
  for (const raw of conf.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) { inLE = line === '[LE]'; continue; }
    const m = inLE && line.match(/^ConnectionSupervisionTimeout\s*=\s*(\d+)/);
    if (m) return Number(m[1]);
  }
  return null;
}

async function procRunning(pattern: string) {
  try { await run('pgrep', ['-f', pattern]); return true; } catch { return false; }
}

export async function runDoctor(): Promise<Check[]> {
  const checks: Check[] = [];

  try {
    const { stdout } = await run('systemctl', ['is-active', 'bluetooth']);
    checks.push({ name: 'bluetooth service', ok: stdout.trim() === 'active', detail: stdout.trim() });
  } catch (e: any) {
    checks.push({ name: 'bluetooth service', ok: false, detail: (e.stdout || 'not running').trim(), fix: 'sudo systemctl start bluetooth' });
  }

  const confPath = '/etc/bluetooth/main.conf';
  const conf = fs.existsSync(confPath) ? fs.readFileSync(confPath, 'utf8') : '';
  const configured = parseSupervisionTimeout(conf);
  let live: number | null = null;
  try { live = Number(fs.readFileSync('/sys/kernel/debug/bluetooth/hci0/supervision_timeout', 'utf8').trim()); } catch { /* needs root */ }
  const effective = live ?? configured;
  const good = effective !== null && effective >= RECOMMENDED_SUPERVISION_TIMEOUT;
  checks.push({
    name: 'LE supervision timeout',
    ok: effective === null ? false : good,
    detail: `main.conf: ${configured === null ? 'default (420 ms)' : `${configured * 10} ms`}` +
      (live === null ? '; live value needs root to read' : `; live: ${live * 10} ms`),
    fix: good ? undefined :
      `Permanent: add "ConnectionSupervisionTimeout=${RECOMMENDED_SUPERVISION_TIMEOUT}" under [LE] in ${confPath}, then sudo systemctl restart bluetooth\n` +
      `Until reboot: echo ${RECOMMENDED_SUPERVISION_TIMEOUT} | sudo tee /sys/kernel/debug/bluetooth/hci0/supervision_timeout`,
  });

  const settingsOpen = (await procRunning('gnome-control-center bluetooth')) || (await procRunning('blueman-manager'));
  checks.push({
    name: 'desktop Bluetooth settings closed',
    ok: !settingsOpen,
    detail: settingsOpen ? 'a Bluetooth settings window is open; it scans and may try to pair with Vector' : 'ok',
    fix: settingsOpen ? 'close it, and never pair Vector from the system menu (Vector rejects OS pairing)' : undefined,
  });

  return checks;
}
