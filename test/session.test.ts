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
    await RtsSession.open(await linkTo(robot), new Sessions(file), { askPin: async () => robot.pin }, 5000);
    await new Promise((r) => setTimeout(r, 50)); // let the post-pair status call save the session
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
