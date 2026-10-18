import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse, printParseErrorCode } from 'jsonc-parser';

const require = createRequire(import.meta.url);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ACCOUNT = /^[a-f0-9]{32}$/i;
const NAME = /^[a-z][a-z0-9-]{1,55}[a-z0-9]$/;

export function argumentsFor(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--dry-run') options.dryRun = true;
    else if (flag === '--help') options.help = true;
    else if (flag === '--name' || flag === '--account-id') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${flag}の値を指定してください。`);
      options[flag === '--name' ? 'name' : 'accountId'] = value;
    } else throw new Error(`未対応のオプション：${flag}`);
  }
  return options;
}

function packageBin(name, binName) {
  const path = require.resolve(`${name}/package.json`);
  return readFile(path, 'utf8').then(JSON.parse).then(pkg => resolve(dirname(path), typeof pkg.bin === 'string' ? pkg.bin : pkg.bin[binName]));
}

// Credentials use stdin/env, never process arguments. Captured output is never
// included in exceptions, since Wrangler authentication output contains secrets.
export function runProcess(executable, args, { cwd, env, input, interactive = false } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true,
      stdio: interactive ? 'inherit' : ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    if (!interactive) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; });
      // Drain stderr without retaining it; it can contain credentials/URLs.
      child.stderr.on('data', () => undefined);
      child.stdin.on('error', () => undefined);
      child.stdin.end(input);
    }
    child.on('error', () => reject(new Error('コマンドを起動できませんでした。依存パッケージを確認してください。')));
    child.on('close', code => code === 0 ? resolveResult(stdout) : reject(new Error(`コマンドが終了コード${code}で失敗しました。`)));
  });
}

export async function setup(options = {}, dependencies = {}) {
  const root = options.root ?? projectRoot;
  const env = dependencies.env ?? process.env;
  const log = dependencies.log ?? console.log;
  const run = dependencies.run ?? runProcess;
  const fetcher = dependencies.fetch ?? fetch;
  const ask = dependencies.ask ?? (async (prompt) => {
    if (!process.stdin.isTTY) throw new Error('CLOUDFLARE_ACCOUNT_IDまたは--account-idを指定してください。');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { return await rl.question(prompt); } finally { rl.close(); }
  });
  const errors = [];
  const template = parse(await readFile(resolve(root, 'wrangler.jsonc'), 'utf8'), errors);
  if (errors.length) throw new Error(`wrangler.jsoncを読み込めません：${printParseErrorCode(errors[0].error)}`);
  const name = options.name ?? template.name;
  if (typeof name !== 'string' || !NAME.test(name)) throw new Error('名前は英小文字から始まる3〜57文字の英小文字・数字・ハイフンで指定してください。');
  let accountId = options.accountId ?? env.CLOUDFLARE_ACCOUNT_ID ?? template.account_id;
  if (accountId && !ACCOUNT.test(accountId)) throw new Error('CloudflareアカウントIDは32桁の16進数です。');
  const configPath = resolve(root, 'wrangler.production.json');
  const stateDir = resolve(root, '.vmv');
  const statePath = resolve(stateDir, 'cloudflare.json');
  const tokenPath = resolve(stateDir, 'upload-token.txt');
  const plan = [
    `対象：${name} / アカウント：${accountId ?? 'ログイン後に選択'}`,
    '既存のD1・R2を確認し、なければ作成 → 本番設定を生成 → DB更新 → ビルド・公開 → トークン設定 → 疎通確認',
    `設定：${configPath}`,
    `アドオン用トークン：${tokenPath}（画面には表示しません）`,
  ];
  plan.forEach(line => log(line));
  if (options.dryRun) {
    log('dry-run：通信・ログイン・ファイル変更・リソース作成は行っていません。');
    return { dryRun: true, name, configPath, tokenPath };
  }
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  let lock;
  try { lock = await open(resolve(stateDir, 'setup.lock'), 'wx', 0o600); }
  catch { throw new Error('セットアップが実行中です。中断後なら.vmv/setup.lockを確認して削除してください。'); }
  let phase = '認証';
  try {
    const wrangler = await packageBin('wrangler', 'wrangler');
    const cli = async (args, input, interactive = false) => run(process.execPath, [wrangler, ...args], { cwd: root, env: { ...env, WRANGLER_SEND_METRICS: 'false' }, input, interactive });
    let state;
    try { state = JSON.parse(await readFile(statePath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('保存済みのセットアップ情報を読み込めません。ファイルを確認してください。'); }
    if (state) {
      if (state.name !== name || (accountId && state.accountId !== accountId) || !ACCOUNT.test(state.accountId) ||
          typeof state.uploadToken !== 'string' || state.uploadToken.length < 32) {
        throw new Error('保存済みの配信先と指定が異なるか、管理情報が無効です。別のチェックアウトで設定してください。');
      }
      accountId ??= state.accountId;
    }
    let token = env.CLOUDFLARE_API_TOKEN;
    if (!token) {
      let credentials;
      try {
        await cli(['whoami', '--json']); // Refresh an expired OAuth token first.
        credentials = JSON.parse(await cli(['auth', 'token', '--json']));
      }
      catch {
        if (!process.stdin.isTTY) throw new Error('先にpnpm exec wrangler loginを実行するか、CLOUDFLARE_API_TOKENを設定してください。');
        log('Cloudflareへログインします。ブラウザで認証を完了してください。');
        await cli(['login'], undefined, true);
        credentials = JSON.parse(await cli(['auth', 'token', '--json']));
      }
      if (!['oauth', 'api_token'].includes(credentials.type) || !credentials.token) throw new Error('APIトークンまたはWranglerのOAuthログインを使用してください。');
      token = credentials.token;
    }
    async function api(path, { method = 'GET', body, allow404 = false } = {}) {
      const response = await fetcher(`https://api.cloudflare.com/client/v4${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (allow404 && response.status === 404) return null;
      if (!response.ok) throw new Error(`Cloudflare API HTTP ${response.status}。認証権限とR2の利用設定を確認してください。`);
      const envelope = await response.json();
      if (!envelope.success) throw new Error('Cloudflare APIが操作を拒否しました。アカウントの権限・利用設定を確認してください。');
      return envelope.result;
    }
    if (!accountId) {
      const accounts = await api('/accounts?per_page=50');
      if (!accounts.length) throw new Error('利用可能なアカウントがありません。');
      if (accounts.length === 1) accountId = accounts[0].id;
      else {
        accounts.forEach((a, i) => log(`${i + 1}: ${a.name} (${a.id})`));
        const answer = Number(await ask('使用するアカウントの番号：'));
        if (!Number.isInteger(answer) || !accounts[answer - 1]) throw new Error('アカウントの番号を確認してください。');
        accountId = accounts[answer - 1].id;
      }
    }
    if (!ACCOUNT.test(accountId)) throw new Error('アカウントIDが無効です。');
    log(`設定するアカウント：${accountId}`);
    const base = `/accounts/${accountId}`;
    phase = '配信先確認';
    const subdomain = await api(`${base}/workers/subdomain`);
    if (!subdomain?.subdomain || !/^[a-z0-9-]+$/.test(subdomain.subdomain)) throw new Error('Cloudflare DashboardでWorkersの初回セットアップ（サブドメイン設定）を完了してください。');
    if (!state?.workerClaimed && await api(`${base}/workers/scripts/${name}/settings`, { allow404: true })) {
      throw new Error('同名のWorkerがすでに存在します。別の--nameを指定してください。既存サービスは上書きしません。');
    }
    state ??= { version: 1, name, accountId, uploadToken: randomBytes(32).toString('hex') };
    async function saveState() {
      const temporary = `${statePath}.tmp`;
      await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
      await rename(temporary, statePath);
    }
    await saveState();
    await writeFile(tokenPath, state.uploadToken + '\n', { mode: 0o600 });
    phase = 'D1・R2作成';
    let database;
    for (let page = 1; ; page++) {
      const databases = await api(`${base}/d1/database?per_page=100&page=${page}`);
      database = databases.find(db => db.name === name);
      if (database || databases.length < 100) break;
    }
    database ??= await api(`${base}/d1/database`, { method: 'POST', body: { name } });
    if (!database.uuid || !/^[a-f0-9-]{36}$/i.test(database.uuid)) throw new Error('D1の作成結果に有効なIDがありません。');
    const bucket = await api(`${base}/r2/buckets/${name}`, { allow404: true });
    if (!bucket) await api(`${base}/r2/buckets`, { method: 'POST', body: { name } });
    const managed = await api(`${base}/r2/buckets/${name}/domains/managed`);
    const custom = await api(`${base}/r2/buckets/${name}/domains/custom`);
    if (managed.enabled || custom.domains.some(domain => domain.enabled)) {
      throw new Error('Cloudflare R2のバケットが公開されています。非公開バケットを用意して再実行してください。');
    }
    log('D1・非公開R2を準備しました。');
    const config = { ...template, name, account_id: accountId, workers_dev: true,
      d1_databases: [{ binding: 'DB', database_name: name, database_id: database.uuid, migrations_dir: 'migrations' }],
      r2_buckets: [{ binding: 'MODELS', bucket_name: name }] };
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
    phase = 'ビルド';
    const tsc = await packageBin('typescript', 'tsc');
    const vite = await packageBin('vite', 'vite');
    await run(process.execPath, [tsc, '--noEmit'], { cwd: root, env });
    await run(process.execPath, [tsc, '--noEmit', '-p', 'tsconfig.app.json'], { cwd: root, env });
    await run(process.execPath, [vite, 'build'], { cwd: root, env });
    phase = 'DBマイグレーション';
    await cli(['d1', 'migrations', 'apply', 'DB', '--remote', '--config', configPath]);
    phase = '公開';
    state.workerClaimed = true;
    await saveState();
    await cli(['deploy', '--config', configPath]);
    phase = 'アップロード用トークン設定';
    await cli(['secret', 'put', 'UPLOAD_TOKEN', '--config', configPath], state.uploadToken + '\n');
    const viewerUrl = `https://${name}.${subdomain.subdomain}.workers.dev`;
    phase = '疎通確認';
    // GET only: no disposable uploads or model contents are sent to production.
    let reachable = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const response = await fetcher(viewerUrl, { redirect: 'error', signal: AbortSignal.timeout(10000) });
        reachable = response.ok && (await response.text()).includes('VirtualModelViewer');
      } catch { /* DNS / first-deploy propagation. */ }
      if (reachable) break;
      await (dependencies.sleep ?? (ms => new Promise(r => setTimeout(r, ms))))(2000);
    }
    if (!reachable) throw new Error('公開先に接続できません。設定は保持されています。時間をおいて再実行してください。');
    state.viewerUrl = viewerUrl;
    await saveState();
    log(`公開完了：${viewerUrl}`);
    log(`Blender／Fusionの配信先に上記URL、管理用トークンには${tokenPath}の内容を設定してください。`);
    return { viewerUrl, configPath, tokenPath };
  } catch (error) {
    // Never embed subprocess or fetch exception text: it may expose credentials.
    const safe = error instanceof Error && /^(保存済み|先にpnpm|APIトークン|利用可能|アカウント|Cloudflare|同名のWorker|D1の|公開先)/.test(error.message) ? ` ${error.message}` : '';
    throw new Error(`${phase}で停止しました。設定を保持したまま再実行できます。${safe}`);
  } finally {
    await lock.close();
    await unlink(resolve(stateDir, 'setup.lock'));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = argumentsFor(process.argv.slice(2));
    if (options.help) console.log('pnpm setup:cloudflare [--dry-run] [--name NAME] [--account-id ID]\nD1・R2作成、ビルド、公開、トークン設定を行います。初回はCloudflareログインとWorkers初回設定が必要です。');
    else await setup(options);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
