import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import worker, { cleanup, type Env } from '../worker';
import { LIFETIME_MS, MAX_MODEL_BYTES, type ModelInfo } from '../shared/model';
import { validateGlb } from '../worker/validation';
import { triangleGlb } from './fixture';

const TOKEN = 'test-only-token-12345678901234567890';
let mf: Miniflare;
let env: Env;
const call = async (path: string, init?: RequestInit) => {
  // Serialize native FormData before crossing Miniflare's undici boundary.
  const request = new Request(`https://viewer.test${path}`, init);
  return mf.dispatchFetch(request.url, {
    method: request.method, headers: [...request.headers],
    body: request.body ? new Uint8Array(await request.arrayBuffer()) : undefined,
  });
};
const upload = (path = '/api/models', method = 'POST', bytes = triangleGlb(), token = TOKEN) => {
  const body = new FormData();
  body.set('metadata', JSON.stringify({ name: '基準モデル', dimensions: { width: 1, height: 1, depth: 0 } }));
  body.set('model', new Blob([bytes as BlobPart], { type: 'model/gltf-binary' }), 'model.glb');
  return call(path, { method, body, headers: { Authorization: `Bearer ${token}` } });
};

beforeAll(async () => {
  const output = await build({ entryPoints: ['worker/index.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' });
  mf = new Miniflare({ modules: true, script: output.outputFiles[0].text, compatibilityDate: '2026-07-30',
    d1Databases: ['DB'], r2Buckets: ['MODELS'], bindings: { UPLOAD_TOKEN: TOKEN },
    serviceBindings: { ASSETS: () => new Response('viewer') } });
  env = { DB: await mf.getD1Database('DB'), MODELS: await mf.getR2Bucket('MODELS'), UPLOAD_TOKEN: TOKEN,
    ASSETS: {} } as unknown as Env;
  const sql = await readFile('migrations/0001_models.sql', 'utf8');
  for (const statement of sql.split(';').filter(x => x.trim())) await env.DB.prepare(statement).run();
}, 30000);
afterAll(async () => { await mf?.dispose(); });

describe('model lifecycle against real local D1 and R2', () => {
  it('requires authentication and rejects malformed uploads', async () => {
    expect((await upload('/api/models', 'POST', triangleGlb(), 'wrong')).status).toBe(401);
    expect((await upload('/api/models', 'POST', new Uint8Array(40))).status).toBe(400);
    expect((await worker.fetch(new Request('https://viewer.test/api/models', {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Length': String(MAX_MODEL_BYTES + 65537) },
    }), env)).status).toBe(413);
  });

  it('publishes, updates the same URL, invalidates old assets, and deletes', async () => {
    const first = await upload();
    expect(first.status).toBe(201);
    const one = await first.json() as ModelInfo;
    expect(one.id).toMatch(/^[a-f0-9]{48}$/);
    expect(Date.parse(one.expiresAt) - Date.now()).toBeGreaterThan(LIFETIME_MS - 10000);
    const asset = await mf.dispatchFetch(one.assetUrl);
    expect(asset.headers.get('cache-control')).toContain('no-store');
    expect(new Uint8Array(await asset.arrayBuffer())).toEqual(triangleGlb());
    const updated = await upload(`/api/models/${one.id}`, 'PUT');
    expect(updated.status).toBe(200);
    const two = await updated.json() as ModelInfo;
    expect(two.viewerUrl).toBe(one.viewerUrl);
    expect(two.revision).not.toBe(one.revision);
    expect((await mf.dispatchFetch(one.assetUrl)).status).toBe(404);
    expect((await call(`/api/models/${one.id}`, { method: 'DELETE' })).status).toBe(401);
    expect((await call(`/api/models/${one.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(204);
    expect((await mf.dispatchFetch(two.assetUrl)).status).toBe(404);
    expect((await env.MODELS.list({ prefix: `${one.id}/` })).objects).toHaveLength(0);
  });

  it('keeps the published model when a new upload fails', async () => {
    const one = await (await upload()).json() as ModelInfo;
    expect((await upload(`/api/models/${one.id}`, 'PUT', new Uint8Array(20))).status).toBe(400);
    const body = new FormData();
    body.set('metadata', JSON.stringify({ name: 'test', dimensions: one.dimensions }));
    body.set('model', new Blob([triangleGlb() as BlobPart]), 'model.glb');
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await worker.fetch(new Request(`https://viewer.test/api/models/${one.id}`, {
      method: 'PUT', body, headers: { Authorization: `Bearer ${TOKEN}` },
    }), { ...env, MODELS: { put: async () => { throw new Error('storage offline'); } } as unknown as R2Bucket });
    errorLog.mockRestore();
    expect(response.status).toBe(500);
    expect((await (await call(`/api/models/${one.id}`)).json() as ModelInfo).revision).toBe(one.revision);
    expect((await mf.dispatchFetch(one.assetUrl)).status).toBe(200);
  });

  it('revokes expired URLs before collection and deletes expired/orphan objects', async () => {
    const one = await (await upload()).json() as ModelInfo;
    await env.DB.prepare('UPDATE models SET expires_at=? WHERE id=?').bind(Date.now() - 1, one.id).run();
    expect((await call(`/api/models/${one.id}`)).status).toBe(404);
    expect((await mf.dispatchFetch(one.assetUrl)).status).toBe(404);
    await env.DB.prepare('UPDATE objects SET created_at=?').bind(Date.now() - LIFETIME_MS).run();
    await cleanup(env);
    expect(await env.DB.prepare('SELECT id FROM models WHERE id=?').bind(one.id).first()).toBeNull();
    expect((await env.MODELS.list({ prefix: `${one.id}/` })).objects).toHaveLength(0);
  });

  it('rejects external URIs and corrupt chunk lengths', () => {
    const glb = triangleGlb();
    validateGlb(glb.buffer as ArrayBuffer);
    const corrupt = glb.slice(); new DataView(corrupt.buffer).setUint32(12, 999999, true);
    expect(() => validateGlb(corrupt.buffer)).toThrow();
    const text = new TextDecoder().decode(glb);
    const external = new TextEncoder().encode(text.replace('"version":"2.0"', '"uri":"https:" '));
    expect(() => validateGlb(external.buffer)).toThrow();
  });
});
