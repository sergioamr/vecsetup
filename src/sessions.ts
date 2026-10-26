// Remembers pairing keys so later connections skip the PIN.
// Same shape as DDL's node-client Sessions, stored as JSON under XDG config.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RtsCliUtil } from './vendor.js';

type Keys = { publicKey: Uint8Array; privateKey: Uint8Array };
type Remote = { name: string; tx: Uint8Array; rx: Uint8Array };
type Data = { 'id-keys'?: Keys; 'remote-keys'?: Record<string, Remote>; 'last-vec'?: string };

export function defaultSessionFile(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'vecsetup', 'sessions.json');
}

const toArr = (u: Uint8Array) => Array.from(u);
const fromArr = (a: number[] | Record<string, number>) =>
  Uint8Array.from(Array.isArray(a) ? a : Object.values(a));

export class Sessions {
  private data: Data = {};

  constructor(private file = defaultSessionFile()) {
    this.load();
  }

  private load() {
    if (!fs.existsSync(this.file)) return;
    const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (raw['id-keys']) {
      this.data['id-keys'] = {
        publicKey: fromArr(raw['id-keys'].publicKey),
        privateKey: fromArr(raw['id-keys'].privateKey),
      };
    }
    if (raw['remote-keys']) {
      this.data['remote-keys'] = {};
      for (const [k, v] of Object.entries<any>(raw['remote-keys'])) {
        this.data['remote-keys'][k] = { name: v.name, tx: fromArr(v.tx), rx: fromArr(v.rx) };
      }
    }
    this.data['last-vec'] = raw['last-vec'];
  }

  save() {
    const out: any = { 'last-vec': this.data['last-vec'] };
    const ids = this.data['id-keys'];
    if (ids) out['id-keys'] = { publicKey: toArr(ids.publicKey), privateKey: toArr(ids.privateKey) };
    if (this.data['remote-keys']) {
      out['remote-keys'] = Object.fromEntries(
        Object.entries(this.data['remote-keys']).map(([k, v]) => [k, { name: v.name, tx: toArr(v.tx), rx: toArr(v.rx) }]),
      );
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(out, null, 2), { mode: 0o600 });
  }

  setLastVector(name: string) { this.data['last-vec'] = name; }
  getLastVector() { return this.data['last-vec']; }

  setKeys(publicKey: Uint8Array, privateKey: Uint8Array) {
    this.data['id-keys'] = { publicKey: Uint8Array.from(publicKey), privateKey: Uint8Array.from(privateKey) };
  }
  getKeys() { return this.data['id-keys']; }

  setSession(remoteKey: Uint8Array, name: string, tx: Uint8Array, rx: Uint8Array) {
    this.data['remote-keys'] ??= {};
    this.data['remote-keys'][RtsCliUtil.keyToHexStr(remoteKey)] = { name, tx: Uint8Array.from(tx), rx: Uint8Array.from(rx) };
  }
  getSession(remoteKey: Uint8Array) {
    return this.data['remote-keys']?.[RtsCliUtil.keyToHexStr(remoteKey)] ?? null;
  }
  deleteSession(remoteKey: Uint8Array) {
    delete this.data['remote-keys']?.[RtsCliUtil.keyToHexStr(remoteKey)];
  }
  clearSessions() { this.data['remote-keys'] = {}; }
}
