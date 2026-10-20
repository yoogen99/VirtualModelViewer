import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startLocalServer, publicOrigin } from './local-server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = '2026.10.1';
const SHA256 = '4d2490e74082c5d48dbfedaf92576fa5bd1702379ab88eb7faa0cfbe8dc891b6';

export function tunnelUrl(text) {
  const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com(?=[\s|]|$)/);
  return match ? publicOrigin(match[0]) : undefined;
}

export async function installTunnel(folder, fetcher = fetch) {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('自動導入はWindows x64に対応しています。ほかの環境ではVMV_CLOUDFLAREDに実行ファイルのパスを指定してください。');
  }
  await mkdir(folder, { recursive: true });
  const path = resolve(folder, `cloudflared-${VERSION}.exe`);
  const valid = bytes => createHash('sha256').update(bytes).digest('hex') === SHA256;
  try { if (valid(await readFile(path))) return path; } catch { /* Download below. */ }
  console.log('公式配布元から一時公開ツールを取得しています。');
  const response = await fetcher(`https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/cloudflared-windows-amd64.exe`);
  if (!response.ok) throw new Error('一時公開ツールを取得できませんでした。');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!valid(bytes)) throw new Error('一時公開ツールの検証に失敗しました。');
  await writeFile(path + '.tmp', bytes);
  await rename(path + '.tmp', path);
  return path;
}

export async function share({ project = root, binary = process.env.VMV_CLOUDFLARED } = {}, dependencies = {}) {
  const folder = resolve(project, '.vmv/local');
  await mkdir(folder, { recursive: true });
  let lock;
  try { lock = await open(resolve(folder, 'session.lock'), 'wx'); }
  catch { throw new Error('配信はすでに起動中です。停止するには pnpm share:stop を実行してください。異常終了後は .vmv/local/session.lock を削除してください。'); }
  let server;
  let child;
  let childClosed = false;
  let stopTimer;
  const connectionFile = resolve(folder, 'connection.json');
  const stopFile = resolve(folder, 'stop');
  let published = false;
  let finish;
  let stopRequested = false;
  const ended = new Promise(accept => { finish = accept; });
  const requestStop = () => { stopRequested = true; finish(); };
  process.once('SIGINT', requestStop);
  process.once('SIGTERM', requestStop);
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
    await unlink(connectionFile).catch(() => undefined);
    await unlink(stopFile).catch(() => undefined);
    stopTimer = setInterval(async () => {
      try { await readFile(stopFile); requestStop(); } catch { /* No stop request. */ }
    }, 1000);
    await readFile(resolve(project, 'dist/index.html'));
    const executable = binary ?? await installTunnel(resolve(project, '.vmv/bin'));
    const tokenFile = resolve(folder, 'upload-token.txt');
    let token;
    try { token = (await readFile(tokenFile, 'utf8')).trim(); }
    catch { token = randomBytes(32).toString('hex'); await writeFile(tokenFile, token, { mode: 0o600 }); }
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('PC配信用トークンファイルを確認してください。');
    if (stopRequested) return;
    server = await (dependencies.startServer ?? startLocalServer)({ root: project, folder, token });
    const config = resolve(folder, 'tunnel.yml');
    await writeFile(config, '{}\n');
    child = (dependencies.spawn ?? spawn)(executable, ['tunnel', '--config', config, '--no-autoupdate', '--url', `http://127.0.0.1:${server.port}`],
      { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    // Attach all listeners immediately: process failures must never be unhandled.
    let timeout;
    const ready = new Promise((accept, reject) => {
      let output = '';
      timeout = setTimeout(() => reject(new Error('一時URLの発行がタイムアウトしました。ネット接続を確認してください。')), 60_000);
      const stop = () => { clearTimeout(timeout); finish(); reject(new Error('一時公開ツールが終了しました。')); };
      child.once('error', stop);
      child.once('close', () => { childClosed = true; stop(); });
      const parse = chunk => {
        output = (output + chunk.toString()).slice(-16384);
        const value = tunnelUrl(output);
        if (value) { clearTimeout(timeout); accept(value); }
      };
      child.stdout.on('data', parse);
      child.stderr.on('data', parse);
    });
    let url;
    try {
      url = await Promise.race([ready, ended.then(() => { throw new Error('PC配信を停止しました。'); })]);
    } finally { clearTimeout(timeout); }
    server.setOrigin(url);
    const session = { serverUrl: url, tokenFile, startedAt: new Date().toISOString(), pid: process.pid };
    await writeFile(connectionFile + '.tmp', JSON.stringify(session, null, 2), { mode: 0o600 });
    await rename(connectionFile + '.tmp', connectionFile);
    published = true;
    console.log(`公開URL：${url}`);
    console.log(`Blenderの「PC配信設定ファイル」に指定：${connectionFile}`);
    console.log('PCを起動し、この配信を動かしている間は別のWi-Fiやモバイル回線でも閲覧できます。');
    console.log('停止：Ctrl+C または pnpm share:stop。起動し直すとURLが変わります。');
    await ended;
    if (!stopRequested) throw new Error('一時公開ツールが終了したため、PC配信を停止しました。再度起動してください。');
  } finally {
    process.removeListener('SIGINT', requestStop);
    process.removeListener('SIGTERM', requestStop);
    clearInterval(stopTimer);
    if (published) await unlink(connectionFile).catch(() => undefined);
    if (child && !childClosed) {
      await new Promise(accept => { child.once('close', accept); child.kill(); });
    }
    await server?.close();
    await lock.close();
    await unlink(resolve(folder, 'session.lock')).catch(() => undefined);
    await unlink(stopFile).catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const action = process.argv[2];
  if (action === '--stop') {
    await mkdir(resolve(root, '.vmv/local'), { recursive: true });
    await writeFile(resolve(root, '.vmv/local/stop'), 'stop');
    console.log('PC配信に停止を要求しました。');
  } else {
    try { await share(); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
