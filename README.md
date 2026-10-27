# vecsetup

**Linux pairing and firmware flashing for Anki Vector robots, from the command line.**

Pair over Bluetooth, put the robot on Wi-Fi, and install firmware images (recovery → unlock → WireOS), with no Chrome and no Web Bluetooth flags.

It speaks every version of Vector's BLE setup protocol ("RTS"), from **v2** (factory and recovery firmware) to **v5/v6** (production firmware and WireOS). It uses Digital Dream Labs' own MIT-licensed protocol code with a new Linux Bluetooth layer (BlueZ over D-Bus).

```
vecsetup doctor                    # check this machine's Bluetooth setup
vecsetup scan                      # list Vectors in range (and whether they are in pairing mode)
vecsetup                           # interactive terminal, same commands as DDL's web setup
vecsetup wifi MyWifi           # put Vector on Wi-Fi (asks for the password)
vecsetup status                    # firmware, Wi-Fi, update state
vecsetup auth                      # sign Vector in with its configured server (your wire-pod)
vecsetup ota ./dev.ota             # serve a local .ota from this machine and install it
vecsetup ota http://host/x.ota     # or install from a URL Vector can reach
```

> Status: early. Verified on one robot (Debian 13, Intel 8260 adapter): pairing with PIN, saved-session reconnect without PIN, `status`, `ip` and `auth` against a local wire-pod on WireOS (RTS v5). The full recovery → unlock → WireOS path was done with the web page this tool replaces; `wifi` and `ota` through vecsetup are covered by tests but not yet run on hardware. Reports from other setups are welcome.

## Install

Requires Node.js 20+, BlueZ and a Bluetooth LE adapter. Your user must be allowed to use BlueZ over D-Bus; on Debian, the `bluetooth` group grants this.

```
git clone https://github.com/sergioamr/vecsetup && cd vecsetup
pnpm install && pnpm build
pnpm link --global      # or run: node dist/cli.js
```

## Pairing

1. Put Vector on its charger and **double-press the backpack button**. It shows its name and enters pairing mode.
2. Run any command, for example `vecsetup status`. On first contact, Vector shows a **PIN** on its face; type it in.
3. The keys are saved in `~/.config/vecsetup/sessions.json`, so later connections skip the PIN. `vecsetup forget` clears them.

**Don't pair Vector from the desktop's Bluetooth settings.** Vector rejects OS-level pairing (you'll see "Authentication Failure"), and an open settings window keeps the adapter busy.

## Findings (why Vector setup fails on Linux)

These are what made a stock Linux laptop fail where phones "see the robot but can't do anything". `vecsetup` works around the ones it can; `vecsetup doctor` checks the rest.

1. **BlueZ's default LE supervision timeout (420 ms) is too short for Vector.** Connections drop within milliseconds with HCI reason `0x3e` ("Connection Failed to be Established"), seen in Chrome as `le-connection-abort-by-local`. Raising it to 5 s fixes this.
   - Permanent: in `/etc/bluetooth/main.conf`, add `ConnectionSupervisionTimeout=500` under the `[LE]` section, then `sudo systemctl restart bluetooth`.
   - Until reboot: `echo 500 | sudo tee /sys/kernel/debug/bluetooth/hci0/supervision_timeout`
2. **DDL's code gives Vector only 3 s to answer the key exchange.** Over a weak link that fails with "Pairing failed. Double press robot button and try again." The vendored copy here uses 30 s.
3. **Disconnect Bluetooth during an OTA.** Vector's Wi-Fi and Bluetooth share one radio. With BLE connected, a download crawled at about 30 KB/s; after dropping BLE it ran at 0.8–1.4 MB/s (a 425 MB image in about 7 minutes). The robot keeps downloading on its own. `vecsetup ota <file>` drops BLE as soon as Vector requests the file (`--keep-ble` to opt out).
4. **Vector is 2.4 GHz only.** A dual-band router's 5 GHz SSID won't appear in its scan. Network names are case-sensitive.
5. **OTA status 203 ("could not open URL") often just means weak Wi-Fi.** In our case the URL was fine: packet loss to the robot was 75%. Moving Vector nearer the router and dropping BLE fixed it.
6. **The recovery firmware speaks RTS v2.** DDL's Go tool [`vector-bluetooth`](https://github.com/digital-dream-labs/vector-bluetooth) did not complete v2 pairing for us, and its 7.5 ms connection interval also dropped on an Intel 8260 adapter.
7. **Chrome on Linux** needs `--enable-experimental-web-platform-features` for Web Bluetooth, and the old `ota.global.anki-dev-services.com` OTA host in mirrored web-setup pages no longer exists. (`vecsetup` avoids both.)

## From recovery to WireOS with root SSH

This is the path that worked for us. Unlocking is done at your own risk; keep Vector on the charger throughout.

1. Recovery mode: hold the backpack button about 15 s on the charger.
2. `vecsetup wifi <ssid>`, then `vecsetup ota unlock-prod.ota`. This is the community unlock image (see [unlock-prod.skittle.dev](https://unlock-prod.skittle.dev/)). The robot then boots with a "confidential unit, not for sale" splash.
3. Recovery mode again, then `vecsetup wifi <ssid>` (a fresh firmware forgets Wi-Fi), then `vecsetup ota dev.ota`. This is the WireOS dev build: see the [WireOS docs](https://os-vector.github.io/vector-docs/2.-Available-CFW/1-WireOS.html) for the current URL.
4. After it reboots, run `vecsetup wifi <ssid>` again, then SSH in as `root` with the global WireOS key ([kercre123/unlocking-vector](https://github.com/kercre123/unlocking-vector)):

   ```
   ssh -i vector_root_key -o PubkeyAcceptedAlgorithms=+ssh-rsa -o HostKeyAlgorithms=+ssh-rsa root@<vector-ip>
   ```

5. Point Vector at your own [wire-pod](https://github.com/kercre123/wire-pod) (its "OSKR/dev bot" setup does this over SSH), then run `vecsetup auth`. This sends the sign-in request that the web setup pages relay, with the same session token wire-pod's own Bluetooth setup uses. Vector then signs in with *your* server; no website is involved.

WireOS source: [os-vector/wire-os](https://github.com/os-vector/wire-os) and [os-vector/wire-os-victor](https://github.com/os-vector/wire-os-victor). For voice commands without DDL's cloud, see [wire-pod](https://github.com/kercre123/wire-pod).

## How it works

- `vendor/rts-js/`: DDL's protocol code from [vector-web-setup](https://github.com/digital-dream-labs/vector-web-setup) (MIT; upstream commit in `UPSTREAM_COMMIT`). The only change is the pairing timeout, 3 s → 30 s, marked `vecsetup:`.
- `src/ble.ts`: the Linux transport (node-ble / BlueZ D-Bus). It frames messages into 20-byte BLE packets, keeps writes in order, and retries connections, because Vector's link often drops while it settles.
- `src/rts.ts`: the version handshake, PIN pairing, encrypted channel, and typed helpers (status, Wi-Fi, IP, OTA).
- `src/otaServer.ts`: serves a local `.ota` over plain HTTP and tracks how much the robot has pulled.
- `test/fakeVector.ts`: a simulated Vector that runs the robot's half of the real pairing crypto, so the tests cover pairing, encryption, reconnection and status without hardware. Run them with `pnpm test`.

## License

MIT. `vendor/rts-js` is © 2019–2020 Digital Dream Labs, MIT (see `vendor/rts-js/LICENSE`). Not affiliated with Anki or Digital Dream Labs.
