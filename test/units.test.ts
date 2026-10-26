import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { parsePairingMode } from '../src/ble.js';
import { parseRouteSrc } from '../src/net.js';
import { parseSupervisionTimeout } from '../src/doctor.js';
import { otaStatusText } from '../src/otaStatus.js';
import { serveOta } from '../src/otaServer.js';
import { Sessions } from '../src/sessions.js';

describe('parsers', () => {
  it('reads pairing mode from Anki manufacturer data', () => {
    // Seen on a real robot: "76 00" normally, 'p' in the 2nd byte after a double-press.
    expect(parsePairingMode({ '1528': { value: Buffer.from([0x76, 0x00]) } })).toBe(false);
    expect(parsePairingMode({ '1528': { value: Buffer.from([0x76, 0x70]) } })).toBe(true);
    expect(parsePairingMode({})).toBeNull();
    expect(parsePairingMode(null)).toBeNull();
  });

  it('finds the source address in `ip route get` output', () => {
    expect(parseRouteSrc('192.168.0.239 dev wlp3s0 src 192.168.0.208 uid 1000 \n    cache')).toBe('192.168.0.208');
    expect(parseRouteSrc('unreachable')).toBeNull();
  });

  it('reads ConnectionSupervisionTimeout only from the [LE] section', () => {
    expect(parseSupervisionTimeout('[General]\nName=x\n[LE]\n#ConnectionSupervisionTimeout=\n')).toBeNull();
    expect(parseSupervisionTimeout('[LE]\nConnectionSupervisionTimeout = 500\n')).toBe(500);
    expect(parseSupervisionTimeout('[GATT]\nConnectionSupervisionTimeout=500\n')).toBeNull();
  });

  it('explains known OTA status codes', () => {
    expect(otaStatusText(203)).toMatch(/could not open URL/);
    expect(otaStatusText(999)).toMatch(/unknown code/);
  });
});

describe('sessions file', () => {
  it('round-trips keys as bytes', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vecsetup-')), 'nested', 's.json');
    const a = new Sessions(file);
    const key = Uint8Array.from({ length: 32 }, (_, i) => i);
    a.setKeys(key, key.slice().reverse());
    a.setSession(key, 'Vector A1B2', Uint8Array.of(1, 2), Uint8Array.of(3, 4));
    a.save();
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');

    const b = new Sessions(file);
    expect(b.getKeys()!.publicKey).toEqual(key);
    expect(b.getSession(key)).toEqual({ name: 'Vector A1B2', tx: Uint8Array.of(1, 2), rx: Uint8Array.of(3, 4) });
    b.deleteSession(key);
    expect(b.getSession(key)).toBeNull();
  });
});

describe('OTA server', () => {
  it('serves the file (ignoring Vector\'s query string) and reports completion', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vecsetup-'));
    const file = path.join(dir, 'dev.ota');
    const body = Buffer.alloc(3 * 1024 * 1024 + 7, 0xab);
    fs.writeFileSync(file, body);

    const events: string[] = [];
    let lastSent = 0;
    let done!: () => void;
    const completed = new Promise<void>((r) => { done = r; });
    const srv = await serveOta(file, {
      request: (_r, u) => events.push(`req ${u}`),
      progress: (sent) => { lastSent = sent; },
      complete: () => { events.push('complete'); done(); },
    }, 0, '127.0.0.1');

    const got = await new Promise<Buffer>((resolve, reject) => {
      http.get(srv.url('127.0.0.1') + '?emresn=00e1f2a3&victorversion=0.9.3.0', (res) => {
        const parts: Buffer[] = [];
        res.on('data', (c) => parts.push(c));
        res.on('end', () => resolve(Buffer.concat(parts)));
      }).on('error', reject);
    });
    await completed;
    expect(got.equals(body)).toBe(true);
    expect(lastSent).toBe(body.length);
    expect(events[0]).toMatch(/^req \/dev\.ota\?emresn=/);

    const status404 = await new Promise<number>((r) => http.get(srv.url('127.0.0.1').replace('dev.ota', 'other.ota'), (res) => { res.resume(); r(res.statusCode!); }));
    expect(status404).toBe(404);
    await srv.close();
  });
});
