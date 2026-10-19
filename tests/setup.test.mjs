import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setup, argumentsFor } from '../scripts/setup-cloudflare.mjs';

const ACCOUNT = 'a'.repeat(32);
const UUID = '12345678-1234-1234-1234-123456789012';
const folders = [];
async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'vmv-setup-')); folders.push(root);
  await writeFile(resolve(root, 'wrangler.jsonc'), await readFile('wrangler.jsonc'));
  const state = { db: false, bucket: false, worker: false, publicBucket: false };
  const calls = [], commands = [], logs = [];
  const run = vi.fn(async (_executable, args, options) => {
    commands.push({ args, options });
    if (args.includes('deploy')) state.worker = true;
    return '';
  });
  const fetcher = vi.fn(async (url, options = {}) => {
    calls.push({ url, options });
    if (url.startsWith('https://virtual-model-viewer.')) return new Response('<title>VirtualModelViewer</title>');
    const path = new URL(url).pathname;
    if (state.r2Disabled && path.includes('/r2/')) return Response.json({ success: false, errors: [{ code: 10042, message: 'Enable R2' }] }, { status: 403 });
    const ok = result => Response.json({ success: true, result });
    if (path.endsWith('/workers/subdomain')) return ok({ subdomain: 'test-account' });
    if (path.endsWith('/settings')) return state.worker ? ok({}) : new Response('', { status: 404 });
    if (path.endsWith('/d1/database')) {
      if (options.method === 'POST') { state.db = true; return ok({ uuid: UUID }); }
      return ok(state.db ? [{ name: 'virtual-model-viewer', uuid: UUID }] : []);
    }
    if (path.endsWith('/domains/managed')) return ok({ enabled: state.publicBucket });
    if (path.endsWith('/domains/custom')) return ok({ domains: [] });
    if (path.endsWith('/r2/buckets/virtual-model-viewer')) return state.bucket ? ok({ name: 'virtual-model-viewer' }) : new Response('', { status: 404 });
    if (path.endsWith('/r2/buckets') && options.method === 'POST') { state.bucket = true; return ok({}); }
    throw new Error('Unexpected endpoint');
  });
  const dependencies = { env: { CLOUDFLARE_API_TOKEN: 'cloud-secret', CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, run,
    fetch: fetcher, log: text => logs.push(text), sleep: async () => undefined };
  return { root, dependencies, calls, commands, logs, state, run, fetcher };
}
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });

describe('Cloudflare setup', () => {
  it('dry-run neither connects nor writes files', async () => {
    const f = await fixture();
    await setup({ root: f.root, dryRun: true }, f.dependencies);
    expect(f.run).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
    expect(await readdir(f.root)).toEqual(['wrangler.jsonc']);
  });
  it('provisions and reuses resources without rotating the upload token', async () => {
    const f = await fixture();
    const result = await setup({ root: f.root }, f.dependencies);
    const first = JSON.parse(await readFile(resolve(f.root, '.vmv/cloudflare.json'), 'utf8'));
    expect(result.viewerUrl).toBe('https://virtual-model-viewer.test-account.workers.dev');
    const config = JSON.parse(await readFile(result.configPath, 'utf8'));
    expect(config.d1_databases[0].database_id).toBe(UUID);
    expect(config.account_id).toBe(ACCOUNT);
    const secret = f.commands.find(c => c.args.includes('secret'));
    expect(secret.options.input.trim()).toBe(first.uploadToken);
    expect(secret.args.join(' ')).not.toContain(first.uploadToken);
    await setup({ root: f.root }, f.dependencies);
    const second = JSON.parse(await readFile(resolve(f.root, '.vmv/cloudflare.json'), 'utf8'));
    expect(second.uploadToken).toBe(first.uploadToken);
    expect(f.calls.filter(c => c.options.method === 'POST')).toHaveLength(2);
    expect(f.logs.join(' ')).not.toContain('cloud-secret'); expect(f.logs.join(' ')).not.toContain(first.uploadToken);
  });
  it('resumes after secret configuration fails, preserving the token', async () => {
    const f = await fixture();
    const normal = f.dependencies.run;
    f.dependencies.run = async (...args) => {
      if (args[1].includes('secret')) throw new Error('sensitive-provider-error-cloud-secret');
      return normal(...args);
    };
    await expect(setup({ root: f.root }, f.dependencies)).rejects.toThrow('アップロード用トークン設定で停止');
    const token = await readFile(resolve(f.root, '.vmv/upload-token.txt'), 'utf8');
    expect(await readdir(resolve(f.root, '.vmv'))).not.toContain('setup.lock');
    f.dependencies.run = normal;
    await setup({ root: f.root }, f.dependencies);
    expect(await readFile(resolve(f.root, '.vmv/upload-token.txt'), 'utf8')).toBe(token);
    expect(f.calls.filter(c => c.options.method === 'POST')).toHaveLength(2);
  });
  it('refuses an unrelated existing Worker and a public bucket', async () => {
    const f = await fixture(); f.state.worker = true;
    await expect(setup({ root: f.root }, f.dependencies)).rejects.toThrow('同名のWorker');
    expect(f.commands).toHaveLength(0);
    f.state.worker = false; f.state.publicBucket = true;
    await expect(setup({ root: f.root }, f.dependencies)).rejects.toThrow('バケットが公開');
    expect(f.commands).toHaveLength(0);
  });
  it('rejects invalid identities before any provisioning', async () => {
    const f = await fixture();
    await expect(setup({ root: f.root, name: '../bad' }, f.dependencies)).rejects.toThrow('名前');
    await expect(setup({ root: f.root, accountId: 'bad' }, f.dependencies)).rejects.toThrow('アカウントID');
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(() => argumentsFor(['--account-id'])).toThrow();
  });
  it('explains R2 activation and resumes without duplicating D1', async () => {
    const f = await fixture(); f.state.r2Disabled = true;
    await expect(setup({ root: f.root }, f.dependencies)).rejects.toThrow('R2の初回有効化');
    expect(f.state.db).toBe(true);
    f.state.r2Disabled = false;
    await setup({ root: f.root }, f.dependencies);
    expect(f.calls.filter(c => c.options.method === 'POST' && new URL(c.url).pathname.endsWith('/d1/database'))).toHaveLength(1);
  });
});
