const get = id => document.getElementById(id);

function send(action, data = {}) {
  if (window.adsk) {
    adsk.fusionSendData(action, JSON.stringify(data));
  } else {
    get('status').textContent = 'Fusionの実寸ARパレットで使用してください。';
  }
}

for (const action of ['new', 'update', 'open', 'delete', 'refresh']) {
  get(action).addEventListener('click', () => send(action));
}
get('qr-button').addEventListener('click', () => send('qr'));
get('settings').addEventListener('click', () => {
  send('settings', { serverUrl: get('server').value, uploadToken: get('token').value });
  get('token').value = '';
});
get('copy').addEventListener('click', async () => {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(get('link').value);
    } else {
      get('link').select();
      if (!document.execCommand('copy')) throw Error();
    }
    get('status').textContent = 'リンクをコピーしました。';
  } catch {
    get('link').select();
    get('status').textContent = 'URLを選択しました。コピー操作を行ってください。';
  }
});

function render(state) {
  const model = state.model || {};
  if (document.activeElement !== get('server')) get('server').value = state.serverUrl;
  get('token-state').textContent = state.tokenConfigured
    ? 'トークン設定済み（保存されません）'
    : 'トークン未設定。起動ごとに入力するかVMV_UPLOAD_TOKENを設定してください。';
  get('status').textContent = state.status;
  get('model').hidden = !model.id;
  get('name').textContent = model.name || '公開中のモデル';
  get('link').value = model.viewerUrl || '';
  get('expires').textContent = model.expiresAt
    ? '有効期限：' + new Date(model.expiresAt).toLocaleString('ja-JP') : '';
  const d = model.dimensions;
  get('sizes').textContent = d
    ? `幅 ${(d.width * 1000).toFixed(2)} / 奥行 ${(d.depth * 1000).toFixed(2)} / 高さ ${(d.height * 1000).toFixed(2)} mm` : '';
  get('qr').hidden = !state.qr;
  if (state.qr) get('qr').src = 'data:image/png;base64,' + state.qr;
  else get('qr').removeAttribute('src');
  for (const id of ['settings', 'new', 'update', 'delete', 'qr-button']) get(id).disabled = state.busy;
  get('new').disabled = state.busy || !state.hasDesign;
  get('update').disabled = state.busy || !state.hasDesign || !model.id;
}

window.fusionJavaScriptHandler = {
  handle(action, data) {
    try {
      if (action === 'state') render(JSON.parse(data));
    } catch {
      get('status').textContent = '表示の更新に失敗しました。「表示を更新」を押してください。';
    }
    return 'OK';
  },
};
document.addEventListener('DOMContentLoaded', () => send('ready'));
