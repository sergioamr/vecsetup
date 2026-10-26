// Loads Digital Dream Labs' RTS protocol code (MIT, CommonJS) from vendor/rts-js.
// The same relative path works from src/ (tests, tsx) and dist/ (built CLI).
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
export const vendorDir = path.resolve(here, '..', 'vendor', 'rts-js');
const requireVendor = createRequire(path.join(vendorDir, 'index.js'));

/* eslint-disable @typescript-eslint/no-explicit-any */
export type AnyHandler = any;

export const { BleMessageProtocol } = requireVendor('./bleMessageProtocol.js') as {
  BleMessageProtocol: new (maxSize: number) => {
    onSendRaw(fn: (buffer: number[]) => void): void;
    setDelegate(d: { handleReceive(data: number[]): void }): void;
    receiveRawBuffer(buffer: number[]): void;
    sendMessage(arr: number[]): void;
  };
};

export const { IntBuffer } = requireVendor('./clad.js') as {
  IntBuffer: { Int32ToLE(v: number): number[]; BufferToUInt32(b: number[]): number };
};

export const { RtsCliUtil } = requireVendor('./rtsCliUtil.js') as {
  RtsCliUtil: { keyToHexStr(k: Uint8Array): string; convertHexToStr(h: string): string; msgToStr(m: unknown): string };
};

const handlers: Record<number, new (ble: any, sodium: any, sessions: any) => AnyHandler> = {
  2: requireVendor('./rtsV2Handler.js').RtsV2Handler,
  3: requireVendor('./rtsV3Handler.js').RtsV3Handler,
  4: requireVendor('./rtsV4Handler.js').RtsV4Handler,
  5: requireVendor('./rtsV5Handler.js').RtsV5Handler,
  6: requireVendor('./rtsV6Handler.js').RtsV6Handler,
};

export function handlerFor(version: number) {
  return handlers[version];
}

export const supportedVersions = Object.keys(handlers).map(Number);
