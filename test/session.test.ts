import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VectorLink } from '../src/ble.js';
import { RtsSession } from '../src/rts.js';
import { Sessions } from '../src/sessions.js';
import { FakeVector } from './fakeVector.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vecsetup-')); });

async function linkTo(robot: FakeVector) {
  const link = new VectorLink();
  const { toRobot, fromRobot } = robot.chars();
  robot.connect();
  await link.attach(toRobot, fromRobot, robot.name);
  return link;
}

describe('pairing with a simulated Vector (RTS v5)', () => {
  it('pairs with the PIN, then talks over the encrypted channel', async () => {
    const robot = await new FakeVector().init();
    const sessions = new Sessions(path.join(dir, 's.json'));
    let asked = 0;
    const s = await RtsSession.open(await linkTo(robot), sessions, { askPin: async () => { asked++; return robot.pin; } }, 5000);

    expect(asked).toBe(1);
    expect(s.version).toBe(5);
    expect(robot.received).toEqual(expect.arrayContaining(['RtsConnResponse', 'RtsAck', 'RtsChallengeMessage']));

    const st = await s.status();
    expect(st.ssid).toBe('MyWifi');
    expect(st.wifiState).toBe(1);
    expect(st.buildVersion).toBe('3.0.2.36d');
    expect((await s.wifiIp()).ipv4).toBe('192.168.0.239');
  });

  it('long messages are split into 20-byte BLE packets', async () => {
    const robot = await new FakeVector().init();
    await RtsSession.open(await linkTo(robot), new Sessions(path.join(dir, 's.json')), { askPin: async () => robot.pin }, 5000);
    expect(robot.rawChunks.length).toBeGreaterThan(3);
    for (const c of robot.rawChunks) expect(c.length).toBeLessThanOrEqual(20);
  });

  it('reconnects with stored keys and does not ask for the PIN again', async () => {
    const robot = await new FakeVector().init();
    const file = path.join(dir, 's.json');
    const first = await RtsSession.open(await linkTo(robot), new Sessions(file), { askPin: async () => robot.pin }, 5000);
    // Call status() straight away, like `vecsetup status` does. This used to orphan the
    // post-pairing status request that decides whether to save keys (seen on a real robot).
    await first.status();
    expect(fs.existsSync(file)).toBe(true);

    const again = await RtsSession.open(await linkTo(robot), new Sessions(file), {
      askPin: async () => { throw new Error('should not ask for a PIN'); },
    }, 5000);
    expect((await again.status()).ssid).toBe('MyWifi');
  });

  it('a wrong PIN never reaches an encrypted connection', async () => {
    // The client's ack goes out in clear; with the wrong PIN it then cannot
    // decrypt the robot's challenge, so it never answers it.
    const robot = await new FakeVector().init();
    const p = RtsSession.open(await linkTo(robot), new Sessions(path.join(dir, 's.json')), { askPin: async () => '000000' }, 800);
    await expect(p).rejects.toThrow(/timed out/);
    expect(robot.received).toContain('RtsAck');
    expect(robot.received).not.toContain('RtsChallengeMessage');
  });
});

describe('cloud sign-in (vecsetup auth)', () => {
  it('relays the wire-pod session token and reports the result', async () => {
    const { WIREPOD_SESSION_TOKEN } = await import('../src/rts.js');
    const robot = await new FakeVector().init();
    const s = await RtsSession.open(await linkTo(robot), new Sessions(path.join(dir, 's.json')), { askPin: async () => robot.pin }, 5000);

    const ok = await s.cloudAuth(WIREPOD_SESSION_TOKEN, 2000);
    expect(ok).toEqual({ success: true, status: 'authorized as primary', clientTokenGuid: 'guid-1234abcd' });
    expect(robot.authRequests).toEqual([WIREPOD_SESSION_TOKEN]);

    const bad = await s.cloudAuth('not-the-token', 2000);
    expect(bad.success).toBe(false);
    expect(bad.status).toBe('invalid session token');
  });
});

describe('finishing first-time setup (onboarding)', () => {
  it('sends settings then marks onboarding complete, with the sign-in client token', async () => {
    const { WIREPOD_SESSION_TOKEN } = await import('../src/rts.js');
    const robot = await new FakeVector().init();
    const s = await RtsSession.open(await linkTo(robot), new Sessions(path.join(dir, 's.json')), { askPin: async () => robot.pin }, 5000);
    const auth = await s.cloudAuth(WIREPOD_SESSION_TOKEN, 2000);

    const steps: string[] = [];
    await s.finishOnboarding(auth.clientTokenGuid, { timeZone: 'Europe/London', locale: 'en-GB', metric: true, fahrenheit: false }, (p, code) => steps.push(`${p} ${code}`));

    expect(robot.sdkCalls.map((c) => c.path)).toEqual([
      '/v1/alexa_opt_in', '/v1/update_account_settings', '/v1/update_settings', '/v1/send_onboarding_input',
    ]);
    expect(robot.sdkCalls.every((c) => c.guid === 'guid-1234abcd')).toBe(true);
    expect(robot.sdkCalls[2].body.settings).toEqual({ time_zone: 'Europe/London', locale: 'en-GB', dist_is_metric: true, temp_is_fahrenheit: false });
    expect(robot.sdkCalls[3].body).toEqual({ onboarding_mark_complete_and_exit: {} });
    expect(steps.every((x) => x.endsWith(' 200'))).toBe(true);
  });

  it('stops at the first failing step', async () => {
    const robot = await new FakeVector().init();
    const s = await RtsSession.open(await linkTo(robot), new Sessions(path.join(dir, 's.json')), { askPin: async () => robot.pin }, 5000);
    await expect(s.finishOnboarding('wrong-guid', { timeZone: 'UTC', locale: 'en-US', metric: true, fahrenheit: false }))
      .rejects.toThrow(/alexa_opt_in failed with status 401/);
    expect(robot.sdkCalls).toHaveLength(1);
  });
});
