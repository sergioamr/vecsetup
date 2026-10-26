// Serves one .ota file over plain HTTP (Vector's updater fetches http URLs)
// and reports how much of it the robot has pulled.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

export type OtaServerEvents = {
  request?: (remote: string, url: string) => void;
  progress?: (sent: number, total: number) => void;
  complete?: (remote: string) => void;
  aborted?: (remote: string, sent: number) => void;
};

export type OtaServer = { url: (host: string) => string; port: number; close: () => Promise<void> };

/** A random port in 40000–60000, the range we use for ad-hoc services. */
export const randomPort = () => 40000 + Math.floor(Math.random() * 20000);

export async function serveOta(file: string, ev: OtaServerEvents = {}, port = randomPort(), bind = '0.0.0.0'): Promise<OtaServer> {
  const total = fs.statSync(file).size;
  const name = path.basename(file);
  const route = '/' + encodeURIComponent(name);

  const server = http.createServer((req, res) => {
    const remote = req.socket.remoteAddress?.replace('::ffff:', '') ?? '?';
    const pathname = new URL(req.url ?? '/', 'http://x').pathname; // Vector appends ?emresn=…&victorversion=…
    ev.request?.(remote, req.url ?? '');
    if (pathname !== route) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': total });
    if (req.method === 'HEAD') { res.end(); return; }

    let sent = 0;
    let lastReport = 0;
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => {
      sent += chunk.length;
      if (sent - lastReport >= 1 << 20 || sent === total) { lastReport = sent; ev.progress?.(sent, total); }
    });
    res.on('finish', () => ev.complete?.(remote));
    res.on('close', () => { if (!res.writableFinished) ev.aborted?.(remote, sent); stream.destroy(); });
    stream.pipe(res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bind, () => resolve());
  });
  const actual = (server.address() as AddressInfo).port;
  return {
    port: actual,
    url: (host: string) => `http://${host}:${actual}${route}`,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
