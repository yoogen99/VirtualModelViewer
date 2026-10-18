import { LIFETIME_MS, MAX_MODEL_BYTES, type ModelInfo } from '../shared/model';
import { HttpError, parseMetadata, validateGlb } from './validation';
import { qrPng } from './qr';

export interface Env {
  DB: D1Database;
  MODELS: R2Bucket;
  ASSETS: Fetcher;
  UPLOAD_TOKEN: string;
}

interface Row {
  id: string; name: string; dimensions: string; revision: string;
  object_key: string; expires_at: number;
}

const ID = /^[a-f0-9]{48}$/;
const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), n => n.toString(16).padStart(2, '0')).join('');
const json = (value: unknown, status = 200) => Response.json(value, {
  status, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' },
});

async function authorize(request: Request, env: Env) {
  if (!env.UPLOAD_TOKEN || env.UPLOAD_TOKEN.length < 32) throw new HttpError(503, 'アップロード用トークンが設定されていません。');
  // Hash to equal-length values before comparison.
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([digest(request.headers.get('Authorization') ?? ''), digest(`Bearer ${env.UPLOAD_TOKEN}`)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  if (difference) throw new HttpError(401, '管理用トークンを確認してください。');
}

async function find(env: Env, id: string): Promise<Row> {
  const row = await env.DB.prepare('SELECT * FROM models WHERE id = ?').bind(id).first<Row>();
  if (!row || row.expires_at <= Date.now()) throw new HttpError(404, 'モデルが見つからないか、有効期限が切れています。');
  return row;
}

function info(row: Row, origin: string): ModelInfo {
  return { id: row.id, name: row.name, dimensions: JSON.parse(row.dimensions), revision: row.revision,
    expiresAt: new Date(row.expires_at).toISOString(), viewerUrl: `${origin}/v/${row.id}`,
    assetUrl: `${origin}/api/models/${row.id}/asset.glb?v=${row.revision}` };
}

async function upload(request: Request, env: Env, origin: string, id?: string) {
  await authorize(request, env);
  const previous = id ? await find(env, id) : undefined;
  if (Number(request.headers.get('Content-Length')) > MAX_MODEL_BYTES + 65536) throw new HttpError(413, 'モデルの上限は25MiBです。');
  if (!request.headers.get('Content-Type')?.startsWith('multipart/form-data')) throw new HttpError(415, 'multipart/form-dataで送信してください。');
  // Bound streaming input too: Content-Length may be missing or forged.
  if (!request.body) throw new HttpError(400, '送信内容がありません。');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.byteLength;
    if (length > MAX_MODEL_BYTES + 65536) {
      await reader.cancel();
      throw new HttpError(413, 'モデルの上限は25MiBです。');
    }
    chunks.push(chunk.value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  let form: FormData;
  try { form = await new Response(body, { headers: { 'Content-Type': request.headers.get('Content-Type')! } }).formData(); }
  catch { throw new HttpError(400, '送信データを読み込めませんでした。'); }
  const metadata = parseMetadata(form.get('metadata'));
  const file = form.get('model');
  if (!file || typeof file === 'string') throw new HttpError(400, 'modelにGLBを指定してください。');
  const bytes = await file.arrayBuffer();
  validateGlb(bytes);
  const modelId = id ?? randomId();
  const revision = crypto.randomUUID();
  const key = `${modelId}/${revision}.glb`;
  await env.DB.prepare('INSERT INTO objects (object_key, created_at) VALUES (?, ?)').bind(key, Date.now()).run();
  await env.MODELS.put(key, bytes, { httpMetadata: { contentType: 'model/gltf-binary' } });
  const row: Row = { id: modelId, name: metadata.name, dimensions: JSON.stringify(metadata.dimensions),
    revision, object_key: key, expires_at: Date.now() + LIFETIME_MS };
  try {
    if (previous) {
      const result = await env.DB.prepare(
        'UPDATE models SET name=?, dimensions=?, revision=?, object_key=?, expires_at=? WHERE id=? AND revision=? AND expires_at>?',
      ).bind(row.name, row.dimensions, revision, key, row.expires_at, modelId, previous.revision, Date.now()).run();
      if (result.meta.changes !== 1) throw new HttpError(409, '別の更新か削除が行われました。状態を確認して再送信してください。');
    } else {
      await env.DB.prepare('INSERT INTO models (id,name,dimensions,revision,object_key,expires_at) VALUES (?,?,?,?,?,?)')
        .bind(modelId, row.name, row.dimensions, revision, key, row.expires_at).run();
    }
  } catch (error) {
    // A transport failure may have occurred after D1 committed. Do not delete
    // a possibly published object; collection checks references before removal.
    if (error instanceof HttpError && error.status === 409) await env.MODELS.delete(key).catch(() => undefined);
    throw error;
  }
  return json(info(row, origin), previous ? 200 : 201);
}

export async function cleanup(env: Env, now = Date.now()) {
  await env.DB.prepare('DELETE FROM models WHERE expires_at <= ?').bind(now).run();
  // Grace period protects uploads in progress. Bound work per scheduled invocation.
  const { results } = await env.DB.prepare(
    'SELECT object_key FROM objects WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM models WHERE models.object_key = objects.object_key) LIMIT 500',
  ).bind(now - 60 * 60 * 1000).all<{ object_key: string }>();
  if (results.length) {
    await env.MODELS.delete(results.map(r => r.object_key));
    await env.DB.batch(results.map(r => env.DB.prepare('DELETE FROM objects WHERE object_key=?').bind(r.object_key)));
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      const response = await env.ASSETS.fetch(request);
      const secured = new Response(response.body, response);
      secured.headers.set('Referrer-Policy', 'no-referrer');
      secured.headers.set('X-Content-Type-Options', 'nosniff');
      secured.headers.set('Permissions-Policy', 'xr-spatial-tracking=(self), camera=(self)');
      return secured;
    }
    try {
      if (url.pathname === '/api/models' && request.method === 'POST') return await upload(request, env, url.origin);
      const match = /^\/api\/models\/([^/]+)(\/(?:asset\.glb|qr\.png))?$/.exec(url.pathname);
      if (!match || !ID.test(match[1])) throw new HttpError(404, 'URLを確認してください。');
      const [, id, asset] = match;
      if (!asset && request.method === 'PUT') return await upload(request, env, url.origin, id);
      if (!asset && request.method === 'DELETE') {
        await authorize(request, env);
        // Revoke first so failures never leave a publicly readable model.
        await env.DB.prepare('DELETE FROM models WHERE id=?').bind(id).run();
        const { results } = await env.DB.prepare('SELECT object_key FROM objects WHERE object_key LIKE ?').bind(`${id}/%`).all<{ object_key: string }>();
        if (results.length) {
          await env.MODELS.delete(results.map(r => r.object_key));
          // Keep registrations until collection: an in-flight upload may still
          // finish its put after this delete. Its failed CAS cannot republish.
        }
        return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, '対応していない操作です。');
      const row = await find(env, id);
      if (!asset) return json(info(row, url.origin));
      if (asset === '/qr.png') return new Response(request.method === 'HEAD' ? null : qrPng(info(row, url.origin).viewerUrl).buffer as ArrayBuffer, {
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
      });
      if (url.searchParams.get('v') && url.searchParams.get('v') !== row.revision) throw new HttpError(404, 'モデルが更新されました。ページを再読み込みしてください。');
      const object = await env.MODELS.get(row.object_key);
      if (!object) throw new HttpError(404, 'モデルファイルが見つかりません。');
      return new Response(request.method === 'HEAD' ? null : object.body, {
        headers: { 'Content-Type': 'model/gltf-binary', 'Content-Length': String(object.size),
          'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer', 'ETag': object.httpEtag },
      });
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      // Never log requests, URLs or authorization values (view URLs are credentials).
      console.error('Model API operation failed');
      return json({ error: '配信処理に失敗しました。時間をおいて再試行してください。' }, 500);
    }
  },
  async scheduled(_event: ScheduledController, env: Env) { await cleanup(env); },
};
