import type { ModelViewerElement } from '@google/model-viewer';
import QRCode from 'qrcode';
import type { ModelInfo } from '../shared/model';
import './style.css';

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `<div class="shell">
  <header><div class="brand">Virtual<span>Model</span>Viewer</div><span class="tag">REAL SCALE · 1 : 1</span></header>
  <main id="content"><section class="empty"><p class="eyebrow">FROM YOUR SCREEN TO YOUR SPACE</p>
  <h1>実寸で、確かめる。</h1><p class="muted">Blenderで選んだモデルを、いつもの空間へ。</p>
  <ol><li>Blenderでモデルを選択</li><li>アドオンの「ARで確認」でリンクを発行</li><li>スマホやQuestでリンクを開いて配置</li></ol>
  <p id="page-status" class="status" role="status">モデルのリンクを開いてください。</p></section></main>
  <footer>実寸表示は倍率100%固定です。位置や見かけの寸法には端末のAR追跡による誤差があります。<br>リンクを知る人は有効期限内に閲覧できます。</footer>
</div>`;

function message(text: string, error = false) {
  const element = document.querySelector<HTMLElement>('#page-status')!;
  element.textContent = text;
  element.classList.toggle('error', error);
}

async function load(id: string) {
  const response = await fetch(`/api/models/${id}`, { cache: 'no-store' });
  const data = await response.json() as ModelInfo & { error?: string };
  if (!response.ok) throw new Error(data.error ?? 'モデルを読み込めませんでした。');
  const model = data as ModelInfo;
  await import('@google/model-viewer');
  document.title = `${model.name} | VirtualModelViewer`;
  document.querySelector('#content')!.innerHTML = `
    <section class="intro"><p class="eyebrow">PLACE IT IN YOUR SPACE</p><h1 id="model-name"></h1><p class="muted">画面の中から、目の前へ。実際のサイズで確認できます。</p></section>
    <section class="stage" aria-label="モデルの3Dプレビュー"><span class="stage-label">実寸モデル / 100%</span>
      <model-viewer id="model" ar ar-modes="scene-viewer quick-look" ar-scale="fixed" ar-placement="floor"
        camera-controls touch-action="pan-y" shadow-intensity="1" exposure="1" interaction-prompt="auto">
        <span slot="ar-button"></span>
      </model-viewer>
    </section>
    <aside>
      <section class="card"><h2>モデルの寸法</h2><dl>
        <div><dt>幅</dt><dd id="width"></dd></div><div><dt>奥行き</dt><dd id="depth"></dd></div><div><dt>高さ</dt><dd id="height"></dd></div>
      </dl><p class="muted small">倍率100% · 拡大縮小なし</p></section>
      <section class="card actions"><h2>空間に配置</h2>
        <div id="quest-options" hidden><label for="surface">配置する面</label><select id="surface"><option value="floor">床</option><option value="table">机・台（高さを指定）</option></select>
        <label id="height-label" hidden>床からの高さ（m）<input id="plane-height" type="number" value="0.75" min="0" max="3" step="0.01"></label>
        <p class="small muted">机は床から測った高さを指定してください。トリガーで配置、グリップ・スティックで回転、B／Yで終了。</p></div>
        <button id="ar" class="primary" disabled>モデルを準備中…</button>
        <button id="reload">最新のモデルを読み込む</button>
        <p id="page-status" class="status small" role="status">3Dモデルを読み込んでいます。</p>
      </section>
      <section class="card"><h2>ほかの端末で開く</h2><div class="share"><img id="qr" alt="このモデルを開くQRコード"><button id="copy">リンクをコピー</button></div>
        <p id="expires" class="small muted"></p>
      </section>
    </aside>`;
  const viewer = document.querySelector<ModelViewerElement>('#model')!;
  const ar = document.querySelector<HTMLButtonElement>('#ar')!;
  document.querySelector('#model-name')!.textContent = model.name;
  viewer.alt = model.name;
  for (const key of ['width', 'depth', 'height'] as const) {
    document.querySelector(`#${key}`)!.textContent = `${(model.dimensions[key] * 1000).toLocaleString('ja-JP', { maximumFractionDigits: 2 })} mm`;
  }
  document.querySelector('#expires')!.textContent = `有効期限：${new Date(model.expiresAt).toLocaleString('ja-JP')}（端末の時刻）`;
  void QRCode.toDataURL(model.viewerUrl, { width: 256, margin: 2 }).then(src => {
    document.querySelector<HTMLImageElement>('#qr')!.src = src;
  }).catch(() => {
    document.querySelector<HTMLImageElement>('#qr')!.hidden = true;
  });
  document.querySelector('#copy')!.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(model.viewerUrl); message('リンクをコピーしました。'); }
    catch { message('コピーできませんでした。ブラウザのアドレス欄からコピーしてください。', true); }
  });
  document.querySelector('#reload')!.addEventListener('click', () => location.reload());
  document.querySelector('#surface')!.addEventListener('change', () => {
    document.querySelector<HTMLElement>('#height-label')!.hidden = document.querySelector<HTMLSelectElement>('#surface')!.value !== 'table';
  });

  const quest = /OculusBrowser|Quest/i.test(navigator.userAgent);
  let supportsXR = false;
  if (quest && navigator.xr) supportsXR = await navigator.xr.isSessionSupported('immersive-ar').catch(() => false);
  if (quest) document.querySelector<HTMLElement>('#quest-options')!.hidden = false;
  viewer.addEventListener('load', () => {
    ar.disabled = quest ? !supportsXR : !viewer.canActivateAR;
    ar.textContent = '実寸で配置';
    message(!ar.disabled ? 'モデルを移動・回転して確認できます。' :
      'ARを利用できません。iPhoneはSafari、AndroidはAR対応端末のChrome、QuestはQuest Browserで開いてください。', ar.disabled);
  });
  viewer.addEventListener('error', () => { ar.disabled = true; message('3Dモデルを読み込めませんでした。Blenderから再送信してください。', true); });
  viewer.addEventListener('ar-status', (event) => {
    if ((event as CustomEvent).detail.status === 'failed') message('ARを開始できませんでした。端末の対応状況と権限を確認してください。', true);
  });
  ar.addEventListener('click', async () => {
    try {
      if (quest) {
        const height = document.querySelector<HTMLSelectElement>('#surface')!.value === 'table'
          ? Number(document.querySelector<HTMLInputElement>('#plane-height')!.value) : 0;
        if (!Number.isFinite(height) || height < 0 || height > 3) throw new Error('配置面の高さを0〜3mで指定してください。');
        // Request within the click gesture, before lazy-loading or fetching assets.
        const sessionPromise = navigator.xr!.requestSession('immersive-ar', { requiredFeatures: ['local-floor'] });
        ar.disabled = true;
        let session: XRSession | undefined;
        try {
          session = await sessionPromise;
          const { startQuest } = await import('./quest');
          await startQuest(model.assetUrl, height, session);
          message('Quest表示を終了しました。');
        } finally {
          if (session) await session.end().catch(() => undefined);
          ar.disabled = Date.now() >= Date.parse(model.expiresAt);
          if (ar.disabled) expire();
        }
      } else {
        await viewer.activateAR();
        message('更新を見るときはAR画面を閉じ、「最新のモデルを読み込む」を押してください。');
      }
    } catch (error) { message(error instanceof Error ? error.message : 'ARを開始できませんでした。', true); }
  });
  // Stop further use after expiration. Already downloaded native AR content cannot be revoked remotely.
  const expire = () => {
    ar.disabled = true;
    viewer.removeAttribute('src');
    message('有効期限が切れました。Blenderから新しいリンクを発行してください。', true);
  };
  const remaining = Date.parse(model.expiresAt) - Date.now();
  if (remaining <= 0) expire();
  else {
    setTimeout(expire, remaining);
    viewer.src = model.assetUrl;
  }
}

const match = /^\/v\/([a-f0-9]{48})\/?$/.exec(location.pathname);
if (match) load(match[1]).catch(error => message(error instanceof Error ? error.message : 'ページを読み込めませんでした。', true));
else if (location.pathname !== '/') message('URLを確認してください。Blenderで発行したリンクから開けます。', true);
