// Linux Bluetooth transport for Vector, via BlueZ over D-Bus (node-ble).
// Implements the small interface DDL's RTS handlers expect:
//   send(), onReceive(), onReceiveUnsubscribe(), tryDisconnect(), sessions.
import { createBluetooth } from 'node-ble';
import type NodeBle from 'node-ble';
import { BleMessageProtocol } from './vendor.js';

export const VECTOR_SERVICE = '0000fee3-0000-1000-8000-00805f9b34fb';
// Named from the robot's side: we write to its "read" characteristic and
// get indications from its "write" characteristic.
export const ROBOT_READ_CHAR = '7d2a4bda-d29b-4152-b725-2491478c5cd7';
export const ROBOT_WRITE_CHAR = '30619f2d-0f54-41bd-a65a-7588d8c85b45';
const ANKI_COMPANY_ID = 0x05f8; // 1528
const MAX_PACKET = 20;

export type Receiver = { receive(data: number[]): void };

export type FoundVector = {
  name: string;
  address: string;
  rssi: number | null;
  pairingMode: boolean | null;
  device: NodeBle.Device;
};

/** Vector advertises Anki manufacturer data; the 2nd byte is 'p' while in pairing mode (after a double-press). */
export function parsePairingMode(manufacturerData: Record<string, unknown> | null | undefined): boolean | null {
  if (!manufacturerData) return null;
  const entry = manufacturerData[String(ANKI_COMPANY_ID)] as any;
  const bytes: Uint8Array | number[] | undefined = entry?.value ?? entry;
  if (!bytes || bytes.length < 2) return null;
  return bytes[1] === 'p'.charCodeAt(0);
}

/** Minimal characteristic surface we use, so tests can pass fakes. */
export type Char = Pick<NodeBle.GattCharacteristic, 'writeValue' | 'startNotifications' | 'on'>;

export class VectorLink {
  sessions: Record<string, unknown> = {};
  name = '';
  bleName = '';
  private listeners: Receiver[] = [];
  private protocol = new BleMessageProtocol(MAX_PACKET);
  private writeQueue: Promise<void> = Promise.resolve();
  private toRobot: Char | null = null;
  private disconnectFn: (() => Promise<void>) | null = null;
  onWriteError: (e: unknown) => void = (e) => console.error('BLE write failed:', e);

  constructor() {
    this.protocol.setDelegate(this);
    this.protocol.onSendRaw((chunk) => this.writeRaw(chunk));
  }

  /** Wire the link to GATT characteristics (also used by tests with fakes). */
  async attach(toRobot: Char, fromRobot: Char, name: string, disconnect?: () => Promise<void>) {
    this.toRobot = toRobot;
    this.name = this.bleName = name;
    this.disconnectFn = disconnect ?? null;
    fromRobot.on('valuechanged', (buf: Buffer) => this.protocol.receiveRawBuffer(Array.from(buf)));
    await fromRobot.startNotifications();
  }

  private writeRaw(chunk: number[]) {
    const ch = this.toRobot;
    if (!ch) throw new Error('not connected');
    // BLE writes must not overlap; keep them strictly in order.
    this.writeQueue = this.writeQueue
      .then(() => ch.writeValue(Buffer.from(chunk), { type: 'request' }))
      .catch(this.onWriteError);
  }

  send(arr: number[]) { this.protocol.sendMessage(arr); }
  onReceive(r: Receiver) { this.listeners.push(r); }
  onReceiveUnsubscribe(r: Receiver) { this.listeners = this.listeners.filter((x) => x !== r); }
  handleReceive(data: number[]) { for (const l of this.listeners.slice()) l.receive(data); }

  /** Resolves once every queued write has been acknowledged. */
  flush() { return this.writeQueue; }

  tryDisconnect() { void this.disconnectFn?.(); }
}

export class Radio {
  private handle = createBluetooth();
  private adapter: NodeBle.Adapter | null = null;

  async getAdapter() {
    if (!this.adapter) {
      this.adapter = await this.handle.bluetooth.defaultAdapter();
      if (!(await this.adapter.isPowered())) throw new Error('Bluetooth adapter is powered off (try: bluetoothctl power on)');
    }
    return this.adapter;
  }

  /** Scan for Vectors. Stops early when `stopWhen` matches. */
  async scan(seconds: number, nameFilter?: string, stopWhen?: (v: FoundVector) => boolean): Promise<FoundVector[]> {
    const adapter = await this.getAdapter();
    if (!(await adapter.isDiscovering())) await adapter.startDiscovery();
    const found = new Map<string, FoundVector>();
    const devices = new Map<string, NodeBle.Device>(); // one proxy per address; each adds D-Bus listeners
    const deadline = Date.now() + seconds * 1000;
    try {
      while (Date.now() < deadline) {
        for (const address of await adapter.devices()) {
          let device = devices.get(address);
          if (!device) { device = await adapter.getDevice(address); devices.set(address, device); }
          const name = await device.getName().catch(() => '');
          if (!name.startsWith('Vector ')) continue;
          if (nameFilter && !name.toLowerCase().includes(nameFilter.toLowerCase())) continue;
          const rssi = await device.getRSSI().then(Number).catch(() => null);
          if (rssi === null) continue; // stale cache entry, not currently advertising
          const md = await device.getManufacturerData().catch(() => null);
          const v: FoundVector = { name, address, rssi, pairingMode: parsePairingMode(md), device };
          found.set(address, v);
          if (stopWhen?.(v)) return [...found.values()];
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    } finally {
      await adapter.stopDiscovery().catch(() => {});
    }
    return [...found.values()];
  }

  /** Connect and open the RTS channel. Retries, because Vector's link often drops while it settles. */
  async connect(v: FoundVector, onDisconnect: () => void, attempts = 4): Promise<VectorLink> {
    let lastErr: unknown;
    for (let i = 1; i <= attempts; i++) {
      try {
        await v.device.connect();
        const gatt = await v.device.gatt();
        const service = await gatt.getPrimaryService(VECTOR_SERVICE);
        const toRobot = await service.getCharacteristic(ROBOT_READ_CHAR);
        const fromRobot = await service.getCharacteristic(ROBOT_WRITE_CHAR);
        const link = new VectorLink();
        v.device.once('disconnect', onDisconnect);
        await link.attach(toRobot, fromRobot, v.name, () => v.device.disconnect());
        return link;
      } catch (e) {
        lastErr = e;
        await v.device.disconnect().catch(() => {});
        if (i < attempts) await new Promise((r) => setTimeout(r, 1000 * i));
      }
    }
    throw new Error(`could not connect to ${v.name} after ${attempts} attempts: ${String(lastErr)}`);
  }

  destroy() { this.handle.destroy(); }
}
