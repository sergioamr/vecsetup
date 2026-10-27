// RTS session: version handshake, PIN pairing, encrypted channel, and typed
// helpers around DDL's protocol handlers (v2 recovery through v6).
import _sodium from 'libsodium-wrappers';
import { IntBuffer, RtsCliUtil, handlerFor, type AnyHandler } from './vendor.js';
import type { VectorLink } from './ble.js';
import { Sessions } from './sessions.js';

export type RtsEvents = {
  askPin: () => Promise<string>;
  print?: (text: string) => void;
  otaProgress?: (v: { status: number; current: number; expected: number }) => void;
};

export type WifiNetwork = { ssid: string; authType: number; signal: number; hidden: boolean };

export class RtsSession {
  handler: AnyHandler = null;
  version = 0;

  private constructor(readonly link: VectorLink, readonly sessions: Sessions) {}

  /**
   * Wait for Vector's handshake, answer with the same version, then pair (PIN on
   * first contact, stored keys afterwards). Resolves once the channel is encrypted.
   */
  static async open(link: VectorLink, sessions: Sessions, ev: RtsEvents, timeoutMs = 60_000): Promise<RtsSession> {
    await _sodium.ready;
    const s = new RtsSession(link, sessions);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for Vector to pair')), timeoutMs);
      const fail = (msg: string) => { clearTimeout(timer); reject(new Error(msg)); };

      link.onReceive({
        receive(data) {
          if (data[0] !== 1 || data.length !== 5 || s.handler) return; // only the first handshake
          const v = IntBuffer.BufferToUInt32(data.slice(1));
          const H = handlerFor(v);
          if (!H) return fail(`Vector asked for RTS v${v}, which is not supported`);
          s.version = v;
          s.handler = new H(link, _sodium, sessions);
          const h = s.handler;

          h.onReadyForPin(() => {
            ev.askPin().then((pin) => h.enterPin(pin.trim()), (e: Error) => fail(e.message));
          });
          h.onPrint((t: string) => {
            if (t.includes('Pairing failed')) return fail('pairing failed (double-press the backpack and try again)');
            ev.print?.(t);
          });
          h.onOtaProgress?.((value: any) =>
            ev.otaProgress?.({ status: Number(value.status), current: Number(value.current), expected: Number(value.expected) }),
          );
          if (h.onCloudAuthorized) h.onCloudAuthorized((value: any) => { if (value.success) s.saveSession(); });
          h.onEncryptedConnection(async () => {
            clearTimeout(timer);
            // Same rule as DDL's client: keep the keys unless the robot is owned and not cloud-authed.
            // Finish this before handing the session out: DDL's handler tracks only one pending
            // request per type, so a caller's own status() would otherwise orphan this one.
            try {
              const m = await h.doStatus();
              if (v <= 3 || !m.value.hasOwner || m.value.isCloudAuthed) s.saveSession();
            } catch { /* keys just aren't saved; pairing still works for this run */ }
            resolve(s);
          });

          link.send([1, ...IntBuffer.Int32ToLE(v)]);
        },
      });
    });
  }

  private saveSession() {
    const h = this.handler;
    this.sessions.setSession(h.remoteKeys.publicKey, this.link.bleName, h.cryptoKeys.encrypt, h.cryptoKeys.decrypt);
    this.sessions.setKeys(h.keys.publicKey, h.keys.privateKey);
    this.sessions.setLastVector(this.link.bleName);
    this.sessions.save();
  }

  async status() {
    const m = await this.handler.doStatus();
    const v = m.value;
    return {
      ssid: v.wifiSsidHex ? RtsCliUtil.convertHexToStr(v.wifiSsidHex) : '',
      wifiState: Number(v.wifiState), // 1 online, 2 local only
      buildVersion: String(v.version ?? v.buildVersion ?? ''),
      otaInProgress: Boolean(v.otaInProgress),
      text: RtsCliUtil.msgToStr(v) as string,
    };
  }

  async wifiScan(): Promise<WifiNetwork[]> {
    const m = await this.handler.doWifiScan();
    this.handler.wifiScanResults = m.value.scanResult;
    return m.value.scanResult.map((r: any) => ({
      ssid: r.wifiSsidHex === 'hidden' ? '' : RtsCliUtil.convertHexToStr(r.wifiSsidHex),
      authType: Number(r.authType),
      signal: Number(r.signalStrength),
      hidden: r.wifiSsidHex === 'hidden' || Boolean(r.hidden),
    }));
  }

  /** Join a network. Auth type comes from a scan when possible (6 = WPA2-PSK). */
  async wifiConnect(ssid: string, password: string, timeoutSec = 15) {
    const nets = await this.wifiScan().catch(() => [] as WifiNetwork[]);
    const exact = nets.find((n) => n.ssid === ssid);
    const caseOnly = !exact && nets.find((n) => n.ssid.toLowerCase() === ssid.toLowerCase());
    if (caseOnly) throw new Error(`no network "${ssid}"; did you mean "${caseOnly.ssid}"? (names are case-sensitive)`);
    const m = await this.handler.doWifiConnect(ssid, password, exact ? exact.authType : 6, timeoutSec);
    return { wifiState: Number(m.value.wifiState), text: RtsCliUtil.msgToStr(m.value) as string };
  }

  async wifiIp(): Promise<{ ipv4: string | null; text: string }> {
    const m = await this.handler.doWifiIp();
    if (!m) throw new Error('Vector did not answer the IP request');
    const v = m.value;
    return { ipv4: v.hasIpV4 ? Array.from(v.ipV4 as number[]).slice(0, 4).join('.') : null, text: RtsCliUtil.msgToStr(v) };
  }

  /** Ask Vector to download and install an OTA from a URL it can reach. */
  otaStart(url: string): Promise<unknown> {
    // DDL's handler only tracks completion when this is set (normally done by its CLI path).
    this.handler.waitForResponse = 'ota-start';
    this.handler.hasProgressBar = true;
    return this.handler.doOtaStart(url);
  }

  otaCancel() { return this.handler.doOtaCancel(''); }
}
