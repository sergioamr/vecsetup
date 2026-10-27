#!/usr/bin/env node
// vecsetup: Bluetooth setup, Wi-Fi and OTA flashing for Anki Vector on Linux.
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Command } from 'commander';
import stringArgv from 'string-argv';
import { Radio, type FoundVector } from './ble.js';
import { RtsSession, WIREPOD_SESSION_TOKEN } from './rts.js';
import { Sessions } from './sessions.js';
import { serveOta } from './otaServer.js';
import { localAddressFor } from './net.js';
import { runDoctor } from './doctor.js';
import { otaStatusText } from './otaStatus.js';

type Opts = { name?: string; pin?: string; scanTime: string };

const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
const log = (s: string) => console.log(s);
const die = (s: string): never => { console.error(`error: ${s}`); process.exit(1); };

async function ask(question: string) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try { return await rl.question(question); } finally { rl.close(); }
}

/** Find a Vector, connect, and open an encrypted RTS session. */
async function connect(opts: Opts, onDrop?: () => void) {
  const radio = new Radio();
  const sessions = new Sessions();
  const seconds = Number(opts.scanTime);
  log(`Scanning for ${opts.name ? `"${opts.name}"` : 'Vector'} (${seconds}s)...`);
  // Stop at once for a robot in pairing mode, otherwise shortly after the first Vector shows up
  // (a little grace so a second robot in range can still be listed).
  const started = Date.now();
  const found = await radio.scan(seconds, opts.name, (v) => v.pairingMode === true || Date.now() - started > 3000);
  if (found.length === 0) die('no Vector found. Put it on the charger and double-press the backpack button.');
  const pick: FoundVector = found.find((v) => v.pairingMode) ?? found.sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999))[0];
  if (found.length > 1 && !opts.name) log(`Found ${found.map((v) => v.name).join(', ')}; using ${pick.name} (use --name to choose)`);
  if (pick.pairingMode === false) log('Note: Vector is not in pairing mode. If this stalls, double-press the backpack button.');

  log(`Connecting to ${pick.name} (${pick.address}, RSSI ${pick.rssi})...`);
  let quiet = false;
  const link = await radio.connect(pick, () => { if (!quiet) { (onDrop ?? (() => die('Bluetooth connection lost')))(); } });
  const session = await RtsSession.open(link, sessions, {
    askPin: () => (opts.pin ? Promise.resolve(opts.pin) : ask('Enter the PIN shown on Vector\'s face: ')),
    print: (t) => log(t),
  });
  log(`Paired: ${pick.name}, protocol v${session.version}`);
  const close = async () => { quiet = true; link.tryDisconnect(); await new Promise((r) => setTimeout(r, 300)); radio.destroy(); };
  return { session, close, link };
}

const program = new Command();
program
  .name('vecsetup')
  .description('Bluetooth setup, Wi-Fi and firmware flashing for Anki Vector robots on Linux')
  .version('0.1.0')
  .option('-n, --name <text>', 'pick a Vector by name, e.g. A1B2')
  .option('-p, --pin <pin>', 'PIN shown on Vector\'s face (otherwise asked for)')
  .option('-s, --scan-time <seconds>', 'how long to scan', '15');

program.command('scan').description('list Vectors in range').action(async () => {
  const o = program.opts<Opts>();
  const radio = new Radio();
  const found = await radio.scan(Number(o.scanTime), o.name);
  radio.destroy();
  if (!found.length) return log('No Vector found.');
  for (const v of found) log(`${v.name}  ${v.address}  RSSI ${v.rssi}  pairing mode: ${v.pairingMode === null ? '?' : v.pairingMode ? 'yes' : 'no'}`);
});

program.command('status').description('show firmware, Wi-Fi and update state').action(async () => {
  const { session, close } = await connect(program.opts());
  log((await session.status()).text);
  await close();
});

program.command('wifi-scan').description('list Wi-Fi networks Vector can see (2.4 GHz only)').action(async () => {
  const { session, close } = await connect(program.opts());
  for (const n of await session.wifiScan()) log(`${String(n.signal).padStart(3)}  ${n.hidden ? '(hidden)' : n.ssid}`);
  await close();
});

program.command('wifi <ssid> [password]').description('connect Vector to Wi-Fi (exact, case-sensitive name)').action(async (ssid: string, password?: string) => {
  const opts = program.opts<Opts>();
  const pw = password ?? (await ask(`Password for ${ssid}: `));
  const { session, close } = await connect(opts);
  const r = await session.wifiConnect(ssid, pw);
  log(r.text);
  const ip = await session.wifiIp().catch(() => null);
  if (ip?.ipv4) log(`Vector's IP: ${ip.ipv4}`);
  await close();
});

program.command('ip').description('show Vector\'s IP address').action(async () => {
  const { session, close } = await connect(program.opts());
  log((await session.wifiIp()).text);
  await close();
});

program
  .command('auth')
  .description('make Vector sign in with its configured server (e.g. your wire-pod); replaces the web setup\'s "activate" step')
  .option('-t, --token <token>', 'session token to relay (default: the one wire-pod\'s own Bluetooth setup uses)', WIREPOD_SESSION_TOKEN)
  .action(async (cmd: { token: string }) => {
    const { session, close } = await connect(program.opts());
    const st = await session.status();
    if (st.wifiState !== 1 && st.wifiState !== 2) die(`Vector is not on Wi-Fi (state ${st.wifiState}). Run: vecsetup wifi <ssid>`);
    log('Asking Vector to sign in with the server in its server_config.json...');
    const r = await session.cloudAuth(cmd.token);
    log(`${r.success ? 'Signed in' : 'Sign-in failed'}: ${r.status}${r.clientTokenGuid ? ` (client token ${r.clientTokenGuid.slice(0, 8)}…)` : ''}`);
    if (!r.success) process.exitCode = 1;
    await close();
  });

program
  .command('ota <fileOrUrl>')
  .description('install firmware: a local .ota file (served from this machine) or an http URL')
  .option('--keep-ble', 'stay connected over Bluetooth during the download (much slower: Wi-Fi and BLE share Vector\'s radio)')
  .action(async (target: string, cmd: { keepBle?: boolean }) => {
    const opts = program.opts<Opts>();
    const isFile = fs.existsSync(target);
    if (!isFile && !/^https?:\/\//.test(target)) die(`${target} is neither a file nor an http(s) URL`);
    if (/^https:/.test(target)) log('Warning: Vector\'s updater may not handle https; plain http is safer.');

    let detached = false;
    const { session, close } = await connect(opts, () => { if (!detached) die('Bluetooth connection lost'); });
    const st = await session.status();
    if (st.wifiState !== 1 && st.wifiState !== 2) die(`Vector is not on Wi-Fi (state ${st.wifiState}). Run: vecsetup wifi <ssid>`);
    const robotIp = (await session.wifiIp().catch(() => ({ ipv4: null }))).ipv4;
    log(`Vector: ${st.buildVersion}, on ${st.ssid || 'Wi-Fi'}${robotIp ? ` at ${robotIp}` : ''}`);

    let url = target;
    let done: Promise<void> = Promise.resolve();
    if (isFile) {
      const host = await localAddressFor(robotIp);
      let finish!: () => void;
      let fail!: (e: Error) => void;
      done = new Promise<void>((res, rej) => { finish = res; fail = rej; });
      let lastPct = -1;
      const server = await serveOta(target, {
        request: (remote, u) => {
          log(`Vector (${remote}) requested ${u}`);
          if (!cmd.keepBle && !detached) {
            detached = true;
            log('Dropping Bluetooth so Vector\'s radio is free for Wi-Fi (download continues on the robot)...');
            void close();
          }
        },
        progress: (sent, total) => {
          const pct = Math.floor((sent / total) * 100);
          if (pct !== lastPct && (pct % 5 === 0 || sent === total)) { lastPct = pct; log(`  sent ${mb(sent)} / ${mb(total)} (${pct}%)`); }
        },
        complete: () => { void server.close(); finish(); },
        aborted: (remote, sent) => log(`  ${remote} dropped the download at ${mb(sent)}; waiting for a retry...`),
      });
      url = server.url(host);
      log(`Serving ${target} at ${url}`);
      setTimeout(() => { if (!detached) fail(new Error('Vector never requested the file. Check that it can reach this machine.')); }, 90_000).unref();
    }

    session.otaStart(url).then(
      () => log('Vector reports the update finished.'),
      (m: any) => { if (!detached) die(otaStatusText(Number(m?.value?.status ?? m?.status))); },
    );
    if (cmd.keepBle || !isFile) {
      let last = '';
      session.handler.onOtaProgress((v: any) => {
        const line = Number(v.expected) > 0 ? `  robot: ${Math.floor((100 * Number(v.current)) / Number(v.expected))}%` : `  robot status ${v.status}`;
        if (line !== last) { last = line; log(line); }
        if (Number(v.status) >= 5 && Number(v.status) !== 0) die(otaStatusText(Number(v.status)));
      });
    }

    await done.catch((e: Error) => die(e.message));
    if (isFile) {
      log('Download complete. Vector is now verifying and installing; leave it on the charger.');
      log('It reboots by itself when done (several minutes). A fresh firmware may need "vecsetup wifi" again.');
      if (!detached) await close();
      process.exit(0);
    }
  });

program.command('shell', { isDefault: true }).description('interactive terminal (same commands as DDL\'s web setup; type "help")').action(async () => {
  const { session, close } = await connect(program.opts(), () => { log('\nBluetooth connection lost'); process.exit(1); });
  const h = session.handler;
  const prompt = `[v${session.version}] ${session.link.bleName.split(' ')[1] ?? ''}$ `;
  const rl = readline.createInterface({ input: stdin, output: stdout, prompt });
  h.onCliResponse((out: string) => { log(out); rl.prompt(); });
  h.onPrint((out: string) => log(out));
  rl.on('line', (line) => {
    const args = stringArgv(line);
    if (!args.length) return rl.prompt();
    if (args[0] === 'exit' || args[0] === 'quit') { rl.close(); return; }
    if (h.handleCli(args)) rl.prompt();
  });
  rl.prompt();
  // Stay in this command until the user quits; the program exits after every command.
  await new Promise<void>((resolve) => rl.on('close', resolve));
  await close();
});

program.command('forget').description('forget stored pairing keys (next connection asks for a PIN)').action(() => {
  const s = new Sessions();
  s.clearSessions();
  s.save();
  log('Stored pairing sessions cleared.');
});

program.command('doctor').description('check this machine\'s Bluetooth setup').action(async () => {
  const checks = await runDoctor();
  for (const c of checks) {
    log(`${c.ok === null ? '?' : c.ok ? 'ok ' : 'BAD'}  ${c.name}: ${c.detail}`);
    if (c.fix) log(`     fix: ${c.fix.replace(/\n/g, '\n          ')}`);
  }
  process.exitCode = checks.every((c) => c.ok !== false) ? 0 : 1;
});

// BlueZ's D-Bus connection keeps Node alive, so exit explicitly once a command is done.
program.parseAsync().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => die(e instanceof Error ? e.message : String(e)),
);
