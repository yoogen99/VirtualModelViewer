"""Network-only helpers; safe to use from background threads (no bpy calls)."""
import json
import re
import uuid
from urllib import error, parse, request

MAX_BYTES = 25 * 1024 * 1024
ID_PATTERN = re.compile(r'^[a-f0-9]{48}$')


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def base_url(value):
    url = parse.urlsplit(value.strip())
    local = url.hostname in {'localhost', '127.0.0.1', '::1'}
    if (url.scheme != 'https' and not (local and url.scheme == 'http')) or not url.netloc:
        raise ValueError('配信先はHTTPSのURLにしてください。ローカル開発のみHTTPを使えます。')
    if url.username or url.password or url.query or url.fragment or url.path not in {'', '/'}:
        raise ValueError('配信先にはパスや認証情報を含まないURLを指定してください。')
    return parse.urlunsplit((url.scheme, url.netloc, '', '', ''))


def _send(url, method='GET', token='', data=None, content_type=None):
    headers = {'User-Agent': 'VirtualModelViewer/0.1'}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    if content_type:
        headers['Content-Type'] = content_type
    req = request.Request(url, data=data, headers=headers, method=method)
    try:
        with request.build_opener(NoRedirect).open(req, timeout=90) as response:
            return response.read(2 * 1024 * 1024)
    except error.HTTPError as exc:
        try:
            detail = json.loads(exc.read(8192)).get('error', '')
        except Exception:
            detail = ''
        raise ValueError(detail or f'配信サーバーでエラーが発生しました（HTTP {exc.code}）。') from None
    except (error.URLError, TimeoutError, OSError):
        raise ValueError('配信サーバーに接続できませんでした。URLとネットワークを確認してください。') from None


def publish(server, token, filepath, name, dimensions, model_id=''):
    server = base_url(server)
    if len(token) < 32:
        raise ValueError('32文字以上の管理用トークンを設定してください。')
    if model_id and not ID_PATTERN.fullmatch(model_id):
        raise ValueError('保存されたモデルIDが無効です。新規送信してください。')
    with open(filepath, 'rb') as handle:
        model = handle.read(MAX_BYTES + 1)
    if len(model) > MAX_BYTES:
        raise ValueError('モデルの上限は25MiBです。形状や画像を軽量化してください。')
    boundary = f'vmv-{uuid.uuid4().hex}'
    metadata = json.dumps({'name': name, 'dimensions': dimensions}, ensure_ascii=False).encode('utf-8')
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n'.encode() + metadata +
            f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="model"; filename="model.glb"\r\nContent-Type: model/gltf-binary\r\n\r\n'.encode() + model +
            f'\r\n--{boundary}--\r\n'.encode())
    path = f'/api/models/{model_id}' if model_id else '/api/models'
    result = json.loads(_send(server + path, 'PUT' if model_id else 'POST', token, body,
                              f'multipart/form-data; boundary={boundary}'))
    if not ID_PATTERN.fullmatch(result.get('id', '')):
        raise ValueError('配信サーバーから無効な応答が返りました。')
    # Never follow a server-supplied URL with an authorization header.
    result['viewerUrl'] = f"{server}/v/{result['id']}"
    result['server'] = server
    return result


def delete(server, token, model_id):
    if not ID_PATTERN.fullmatch(model_id):
        raise ValueError('モデルIDが無効です。')
    _send(base_url(server) + f'/api/models/{model_id}', 'DELETE', token)


def fetch_qr(server, model_id):
    if not ID_PATTERN.fullmatch(model_id):
        raise ValueError('モデルIDが無効です。')
    png = _send(base_url(server) + f'/api/models/{model_id}/qr.png')
    if not png.startswith(b'\x89PNG\r\n\x1a\n'):
        raise ValueError('QRコードを取得できませんでした。')
    return png
