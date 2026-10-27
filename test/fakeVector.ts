// A simulated Vector speaking RTS v5 over fake GATT characteristics. It runs the
// robot's half of the real pairing crypto, so tests exercise our transport,
// DDL's handler and the session store end to end, without hardware.
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import _sodium from 'libsodium-wrappers';
import { BleMessageProtocol, vendorDir } from '../src/vendor.js';
import type { Char } from '../src/ble.js';

const req = createRequire(vendorDir + '/index.js');
const { Anki } = req('./messageExternalComms.js');
const Rts = Anki.Vector.ExternalComms;

type Remembered = { clientPub: Uint8Array; tx: Uint8Array; rx: Uint8Array };

export class FakeVector {
  readonly pin = '123456';
  readonly name = 'Vector T3ST';
  readonly status = { ssid: 'MyWifi', wifiState: 1, version: '3.0.2.36d', esn: '00e1f2a3' };
  readonly ip = [192, 168, 0, 239];
  private keys!: { publicKey: Uint8Array; privateKey: Uint8Array };
  private remembered: Remembered | null = null;
  private proto = new BleMessageProtocol(20);
  private fromRobot = new EventEmitter();
  private encrypted = false;
  private cryptoKeys: { tx: Uint8Array; rx: Uint8Array } | null = null;
  private nonces: { toRobot: Uint8Array; toDevice: Uint8Array } | null = null;
  private challenge = 0;
  private pendingClientPub: Uint8Array | null = null;
  received: string[] = []; // tags of messages the client sent, for assertions
  acceptedToken = '2vMhFgktH3Jrbemm2WHkfGN';
  authRequests: string[] = [];
  rawChunks: number[][] = [];

  async init() {
    await _sodium.ready;
    this.keys = _sodium.crypto_kx_keypair();
    this.proto.setDelegate(this);
    this.proto.onSendRaw((chunk) => setImmediate(() => this.fromRobot.emit('valuechanged', Buffer.from(chunk))));
    return this;
  }

  /** Characteristics as seen from the client. */
  chars(): { toRobot: Char; fromRobot: Char } {
    const self = this;
    const toRobot = {
      writeValue: async (buf: Buffer) => { self.rawChunks.push(Array.from(buf)); self.proto.receiveRawBuffer(Array.from(buf)); },
      startNotifications: async () => {},
      on: () => toRobot,
    } as unknown as Char;
    const fromRobot = {
      writeValue: async () => {},
      startNotifications: async () => {},
      on: (ev: string, fn: (b: Buffer) => void) => { self.fromRobot.on(ev, fn); return fromRobot; },
    } as unknown as Char;
    return { toRobot, fromRobot };
  }

  /** A new BLE connection: reset link state and greet with the v5 handshake. */
  connect() {
    this.encrypted = false;
    this.cryptoKeys = null;
    this.proto = new BleMessageProtocol(20);
    this.proto.setDelegate(this);
    this.proto.onSendRaw((chunk) => setImmediate(() => this.fromRobot.emit('valuechanged', Buffer.from(chunk))));
    this.fromRobot.removeAllListeners();
    setImmediate(() => this.sendRaw([1, 5, 0, 0, 0]));
  }

  private sendRaw(bytes: number[]) { this.proto.sendMessage(bytes); }

  private send(msg5: any) {
    const packed = Rts.ExternalComms.NewExternalCommsWithRtsConnection(
      Rts.RtsConnection.NewRtsConnectionWithRtsConnection_5(msg5),
    ).pack();
    let bytes: Uint8Array = Uint8Array.from(packed);
    if (this.encrypted) {
      bytes = _sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(bytes, null, null, this.nonces!.toDevice, this.cryptoKeys!.tx);
      _sodium.increment(this.nonces!.toDevice);
    }
    this.sendRaw(Array.from(bytes));
  }

  // Delegate for BleMessageProtocol: a full message arrived from the client.
  handleReceive(data: number[]) {
    if (data[0] === 1 && data.length === 5) {
      // Client answered the handshake: ask to connect.
      this.send(Rts.RtsConnection_5.NewRtsConnection_5WithRtsConnRequest(new Rts.RtsConnRequest(this.keys.publicKey)));
      return;
    }
    let bytes = Uint8Array.from(data);
    if (this.encrypted) {
      try {
        bytes = _sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, bytes, null, this.nonces!.toRobot, this.cryptoKeys!.rx);
        _sodium.increment(this.nonces!.toRobot);
      } catch {
        this.received.push('UNDECRYPTABLE'); // e.g. wrong PIN; a real robot drops the link
        return;
      }
    }
    const comms = new Rts.ExternalComms();
    comms.unpack(Array.from(bytes));
    const msg = comms.value.value;
    const tagName = Object.keys(Rts.RtsConnection_5Tag).find((k) => Rts.RtsConnection_5Tag[k] === msg.tag) ?? String(msg.tag);
    this.received.push(tagName);
    this.onMessage(tagName, msg.value);
  }

  private startNonces() {
    this.nonces = { toRobot: _sodium.randombytes_buf(24), toDevice: _sodium.randombytes_buf(24) };
    this.send(Rts.RtsConnection_5.NewRtsConnection_5WithRtsNonceMessage(
      new Rts.RtsNonceMessage(Uint8Array.from(this.nonces.toRobot), Uint8Array.from(this.nonces.toDevice)),
    ));
  }

  private onMessage(tag: string, v: any) {
    switch (tag) {
      case 'RtsConnResponse': {
        const clientPub = Uint8Array.from(v.publicKey);
        if (v.connectionType === Rts.RtsConnType.Reconnection && this.remembered &&
            _sodium.memcmp(this.remembered.clientPub, clientPub)) {
          this.cryptoKeys = { tx: this.remembered.tx, rx: this.remembered.rx };
        } else {
          this.pendingClientPub = clientPub; // first-time pair: keys come from the PIN
        }
        this.startNonces();
        break;
      }
      case 'RtsAck': {
        if (this.pendingClientPub) {
          const s = _sodium.crypto_kx_server_session_keys(this.keys.publicKey, this.keys.privateKey, this.pendingClientPub);
          this.cryptoKeys = {
            rx: _sodium.crypto_generichash(32, s.sharedRx, this.pin),
            tx: _sodium.crypto_generichash(32, s.sharedTx, this.pin),
          };
          this.remembered = { clientPub: this.pendingClientPub, ...this.cryptoKeys };
          this.pendingClientPub = null;
        }
        this.encrypted = true;
        this.challenge = 1000 + Math.floor(Math.random() * 1000);
        this.send(Rts.RtsConnection_5.NewRtsConnection_5WithRtsChallengeMessage(new Rts.RtsChallengeMessage(this.challenge)));
        break;
      }
      case 'RtsChallengeMessage':
        if (v.number === this.challenge + 1) {
          this.send(Rts.RtsConnection_5.NewRtsConnection_5WithRtsChallengeSuccessMessage(new Rts.RtsChallengeSuccessMessage()));
        }
        break;
      case 'RtsStatusRequest': {
        const st = this.status;
        const ssidHex = Buffer.from(st.ssid).toString('hex').toUpperCase();
        this.send(Rts.RtsConnection_5.NewRtsConnection_5WithRtsStatusResponse_5(
          new Rts.RtsStatusResponse_5(ssidHex, st.wifiState, false, 0, 0, st.version, st.esn, false, false, false),
        ));
        break;
      }
      case 'RtsWifiIpRequest':
        this.send(Rts.RtsConnection_5.NewRtsConnection_5WithRtsWifiIpResponse(
          new Rts.RtsWifiIpResponse(true, false, Uint8Array.from(this.ip), new Uint8Array(16)),
        ));
        break;
      case 'RtsCloudSessionRequest_5': {
        // Like vic-cloud signing in with wire-pod: only the expected token works.
        const ok = v.sessionToken === this.acceptedToken;
        this.authRequests.push(v.sessionToken);
        setTimeout(() => this.send(Rts.RtsConnection_5.NewRtsConnection_5WithRtsCloudSessionResponse(
          new Rts.RtsCloudSessionResponse(ok, ok ? Rts.RtsCloudStatus.AuthorizedAsPrimary : Rts.RtsCloudStatus.InvalidSessionToken, ok ? 'guid-1234abcd' : ''),
        )), 20); // the real robot takes a moment: it talks to the server first
        break;
      }
    }
  }
}
