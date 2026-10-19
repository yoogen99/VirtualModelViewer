import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const API = /^\/api\/models(?:\/[a-f0-9]{48}(?:\/(?:asset\.glb|qr\.png))?)?$/;
const PAGE = /^\/(?:v\/[a-f0-9]{48})?$/;
const ASSET = /^\/assets\/[a-zA-Z0-9_.-]+$/;
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

export function publicOrigin(value) {
  const url = new URL(value);
  if (url.origin !== value || !/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(value)) {
    throw new Error('一時公開URLを確認できませんでした。');
  }
  return value;
}

export async function startLocalServer({ root, folder, token, port = 0, viewerDir = resolve(root, 'dist') }) {
  await mkdir(folder, { recursive: true });
  const output = await build({ entryPoints: [resolve(root, 'worker/local.ts')], bundle: true,
    write: false, format: 'esm', platform: 'browser' });
  const mf = new Miniflare({ modules: true, script: output.outputFiles[0].text,
    host: '127.0.0.1', port: 0, compatibilityDate: '2026-07-30',
    d1Databases: ['DB'], r2Buckets: ['MODELS'],
    d1Persist: resolve(folder, 'database'), r2Persist: resolve(folder, 'models'),
    bindings: { UPLOAD_TOKEN: token },
    serviceBindings: { ASSETS: async request => {
      const path = new URL(request.url).pathname;
      if (!['GET', 'HEAD'].includes(request.method) || !(PAGE.test(path) || ASSET.test(path))) {
        return new Response('Not found', { status: 404 });
      }
      try {
        const file = PAGE.test(path) ? 'index.html' : path.slice(1);
        const bytes = await readFile(resolve(viewerDir, file));
        const ext = file.slice(file.lastIndexOf('.'));
        return new Response(request.method === 'HEAD' ? null : bytes, { headers: {
          'Content-Type': ext === '.html' ? 'text/html; charset=utf-8' : MIME[ext] ?? 'application/octet-stream',
          'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
        } });
      } catch { return new Response('Not found', { status: 404 }); }
    } },
  });
  let timer;
  let origin;
  let server;
  const collect = () => mf.dispatchFetch('http://local/__vmv_collect', { method: 'POST' });
  try {
    const db = await mf.getD1Database('DB');
    // One migration today; CREATE IF NOT EXISTS keeps restarts safe.
    const sql = await readFile(resolve(root, 'migrations/0001_models.sql'), 'utf8');
    for (const statement of sql.split(';').filter(s => s.trim())) {
      await db.prepare(statement.replace(/CREATE TABLE /g, 'CREATE TABLE IF NOT EXISTS ')
        .replace(/CREATE INDEX /g, 'CREATE INDEX IF NOT EXISTS ')).run();
    }
    await collect();
    timer = setInterval(() => collect().catch(() => console.error('期限切れデータの回収に失敗しました。')), 15 * 60 * 1000);
    timer.unref();
    server = createServer(async (req, res) => {
      try {
        // Allow only application routes. Never expose the runtime, local inspector,
        // storage explorer, arbitrary files, or caller-controlled forwarding hosts.
        const raw = req.url ?? '';
        const path = raw.split('?')[0];
        if (!(API.test(path) || PAGE.test(path) || ASSET.test(path))) {
          req.resume(); res.writeHead(404); res.end('Not found'); return;
        }
        if (!origin) { req.resume(); res.writeHead(503); res.end('公開URLを準備しています。'); return; }
        const headers = new Headers();
        for (const key of ['content-type', 'content-length', 'authorization']) {
          if (typeof req.headers[key] === 'string') headers.set(key, req.headers[key]);
        }
        // Stream uploads into the API's size guard rather than buffering at the gateway.
        const response = await mf.dispatchFetch(origin + raw, { method: req.method, headers: [...headers],
          body: ['GET', 'HEAD'].includes(req.method) ? undefined : req, duplex: 'half' });
        res.writeHead(response.status, Object.fromEntries(response.headers));
        if (response.body && req.method !== 'HEAD') await pipeline(Readable.fromWeb(response.body), res);
        else res.end();
      } catch {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    });
    server.requestTimeout = 120_000;
    await new Promise((accept, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', accept);
    });
    return {
      port: server.address().port,
      setOrigin(value) { origin = publicOrigin(value); },
      collect,
      async close() {
        clearInterval(timer);
        server.closeAllConnections();
        await new Promise(accept => server.close(accept));
        await mf.dispose();
      },
    };
  } catch (error) {
    clearInterval(timer);
    server?.close();
    await mf.dispose();
    throw error;
  }
}
