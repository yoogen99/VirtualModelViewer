import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startLocalServer, publicOrigin } from '../scripts/local-server.mjs';
import { tunnelUrl } from '../scripts/share-local.mjs';
import { triangleGlb } from './fixture';

const token = '1234567890123456789012345678901234567890';
const origin = 'https://vmv-test.trycloudflare.com';
let folder;
let server;
let local;
let model;
const options = () => ({ root: process.cwd(), folder: resolve(folder, 'data'), token,
  viewerDir: resolve(folder, 'dist') });
const upload = (path = '/api/models', method = 'POST', bytes = triangleGlb(), auth = token) => {
  const body = new FormData();
  body.set('metadata', JSON.stringify({ name: 'local-test', dimensions: { width: 1, height: 1, depth: 0 } }));
  body.set('model', new Blob([bytes]), 'model.glb');
  return fetch(local + path, { method, body,
    headers: { Authorization: `Bearer ${auth}`, 'X-Forwarded-Host': 'attacker.invalid', 'X-Forwarded-Proto': 'http' } });
};

beforeAll(async () => {
  folder = await mkdtemp(resolve(tmpdir(), 'vmv-local-'));
  await mkdir(resolve(folder, 'dist/assets'), { recursive: true });
  await writeFile(resolve(folder, 'dist/index.html'), '<html>viewer</html>');
  await writeFile(resolve(folder, 'dist/assets/app-123.js'), 'export {};');
  server = await startLocalServer(options());
  local = `http://127.0.0.1:${server.port}`;
}, 30000);
afterAll(async () => { await server?.close(); await rm(folder, { recursive: true, force: true }); });

it('waits for a validated public origin and never exposes local admin routes or files', async () => {
  expect((await fetch(local)).status).toBe(503);
  for (const path of ['/__vmv_collect', '/cdn-cgi/local/explorer', '/.vmv/local/upload-token.txt', '/worker/index.ts', '/assets/%2e%2e%2findex.html']) {
    expect((await fetch(local + path)).status).toBe(404);
  }
  for (const value of ['http://vmv-test.trycloudflare.com', 'https://evil.invalid', origin + '/path', origin + '@evil.invalid']) {
    expect(() => publicOrigin(value)).toThrow();
  }
  server.setOrigin(origin);
  const page = await fetch(local);
  expect(await page.text()).toContain('viewer');
  expect(page.headers.get('permissions-policy')).toContain('xr-spatial-tracking');
  expect((await fetch(local + '/assets/app-123.js')).headers.get('content-type')).toBe('text/javascript');
  expect((await fetch(local, { method: 'POST' })).status).toBe(404);
});

it('streams uploads, preserves the trusted HTTPS origin, and retains the old version on failure', async () => {
  expect((await upload('/api/models', 'POST', triangleGlb(), 'wrong')).status).toBe(401);
  const first = await upload();
  expect(first.status).toBe(201);
  model = await first.json();
  expect(model.viewerUrl).toBe(`${origin}/v/${model.id}`);
  expect((await fetch(local + `/api/models/${model.id}/qr.png`)).headers.get('content-type')).toBe('image/png');
  const assetPath = new URL(model.assetUrl).pathname + new URL(model.assetUrl).search;
  expect(new Uint8Array(await (await fetch(local + assetPath)).arrayBuffer())).toEqual(triangleGlb());
  expect((await upload(`/api/models/${model.id}`, 'PUT', new Uint8Array(32))).status).toBe(400);
  expect((await (await fetch(local + `/api/models/${model.id}`)).json()).revision).toBe(model.revision);
  const update = await (await upload(`/api/models/${model.id}`, 'PUT')).json();
  expect(update.viewerUrl).toBe(model.viewerUrl);
  expect(update.revision).not.toBe(model.revision);
  expect((await fetch(local + assetPath)).status).toBe(404);
});

it('persists only on the PC, reconstructs URLs after restart, and revokes on deletion', async () => {
  await server.close();
  server = undefined;
  server = await startLocalServer(options());
  local = `http://127.0.0.1:${server.port}`;
  const nextOrigin = 'https://vmv-next.trycloudflare.com';
  server.setOrigin(nextOrigin);
  const saved = await (await fetch(local + `/api/models/${model.id}`)).json();
  expect(saved.viewerUrl).toBe(`${nextOrigin}/v/${model.id}`);
  const response = await fetch(local + new URL(saved.assetUrl).pathname);
  expect(response.status).toBe(200);
  expect((await fetch(local + `/api/models/${model.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })).status).toBe(204);
  expect((await fetch(local + new URL(saved.assetUrl).pathname)).status).toBe(404);
});

it('recognizes only the expected tunnel URL', () => {
  expect(tunnelUrl(`| ${origin} |\n`)).toBe(origin);
  expect(tunnelUrl('https://evil.invalid')).toBeUndefined();
  expect(tunnelUrl(origin + '.evil.invalid ')).toBeUndefined();
});
