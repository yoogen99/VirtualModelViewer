import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, readFile, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { share } from '../scripts/share-local.mjs';

let project;
let server;
let child;
let spawn;
const connection = () => resolve(project, '.vmv/local/connection.json');
const lock = () => resolve(project, '.vmv/local/session.lock');
beforeEach(async () => {
  project = await mkdtemp(resolve(tmpdir(), 'vmv-share-'));
  await mkdir(resolve(project, 'dist'));
  await writeFile(resolve(project, 'dist/index.html'), 'viewer');
  server = { port: 12345, setOrigin: vi.fn(), close: vi.fn() };
  child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null });
  child.kill = vi.fn(() => { child.exitCode = 0; queueMicrotask(() => child.emit('close', 0)); });
  spawn = vi.fn(() => {
    queueMicrotask(() => child.stderr.write('https://test-share.trycloudflare.com |\n'));
    return child;
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(async () => { vi.restoreAllMocks(); await rm(project, { recursive: true, force: true }); });
const run = () => share({ project, binary: 'test-tunnel' }, { spawn, startServer: async () => server });

it('publishes connection settings, rejects a second session, and cleans up on stop', async () => {
  const running = run();
  await vi.waitFor(async () => expect(JSON.parse(await readFile(connection(), 'utf8')).serverUrl)
    .toBe('https://test-share.trycloudflare.com'));
  const state = JSON.parse(await readFile(connection(), 'utf8'));
  expect(state).not.toHaveProperty('uploadToken');
  expect((await readFile(state.tokenFile, 'utf8')).length).toBe(64);
  await expect(run()).rejects.toThrow('すでに起動中');
  expect(spawn.mock.calls[0][2]).toMatchObject({ shell: false, windowsHide: true });
  await writeFile(resolve(project, '.vmv/local/stop'), 'stop');
  await running;
  expect(child.kill).toHaveBeenCalled();
  expect(server.close).toHaveBeenCalled();
  await expect(access(connection())).rejects.toThrow();
  await expect(access(lock())).rejects.toThrow();
});

it('closes the local server and releases the lock when the tunnel fails before it is ready', async () => {
  spawn.mockImplementation(() => {
    queueMicrotask(() => { child.exitCode = 1; child.emit('close', 1); });
    return child;
  });
  await expect(run()).rejects.toThrow();
  expect(server.close).toHaveBeenCalled();
  await expect(access(connection())).rejects.toThrow();
  await expect(access(lock())).rejects.toThrow();
});

it('revokes the connection file when the tunnel unexpectedly disconnects', async () => {
  const running = run();
  const failed = expect(running).rejects.toThrow('一時公開ツールが終了');
  await vi.waitFor(async () => expect(await readFile(connection(), 'utf8')).toContain('serverUrl'));
  // A signal exit has exitCode === null even though close already fired.
  child.signalCode = 'SIGTERM';
  child.emit('close', null, 'SIGTERM');
  await failed;
  expect(server.close).toHaveBeenCalled();
  await expect(access(connection())).rejects.toThrow();
});
