"""Store the endpoint locally and the model link in its originating design.

Upload credentials intentionally remain in memory/environment only.
"""
import json
import os
from pathlib import Path

GROUP = 'VirtualModelViewer'
KEY = 'published_model'


def settings_path():
    return Path(os.environ.get('VMV_FUSION_SETTINGS', str(Path.home() / '.virtualmodelviewer' / 'fusion-settings.json')))


def load_settings():
    path = settings_path()
    if not path.exists():
        return {}
    value = json.loads(path.read_text(encoding='utf8'))
    return {'serverUrl': value.get('serverUrl', '')}


def save_settings(server):
    path = settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    with open(temporary, 'w', encoding='utf8') as handle:
        json.dump({'serverUrl': server}, handle, ensure_ascii=False)
    temporary.replace(path)


def read_model(design):
    if not design or not design.isValid:
        return {}
    attribute = design.rootComponent.attributes.itemByName(GROUP, KEY)
    if not attribute:
        return {}
    try:
        value = json.loads(attribute.value)
        return value if isinstance(value, dict) else {}
    except (ValueError, TypeError):
        return {}


def write_model(design, model):
    if not design or not design.isValid:
        return False
    # Explicit allowlist: never put tokens or downloaded images in a document.
    allowed = ('id', 'server', 'viewerUrl', 'expiresAt', 'dimensions', 'name')
    value = {key: model[key] for key in allowed if key in model}
    if not design.rootComponent.attributes.add(GROUP, KEY, json.dumps(value, ensure_ascii=False)):
        raise ValueError('リンク情報をデザインに保存できませんでした。')
    return True


def clear_model(design):
    if not design or not design.isValid:
        return False
    attribute = design.rootComponent.attributes.itemByName(GROUP, KEY)
    if attribute:
        attribute.deleteMe()
    return True
