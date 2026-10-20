bl_info = {
    'name': 'VirtualModelViewer',
    'author': 'VirtualModelViewer contributors',
    'version': (0, 1, 0),
    'blender': (4, 5, 0),
    'location': '3D View > Sidebar > 実寸AR',
    'description': '選択モデルをスマホ・Questで実寸表示します',
    'category': '3D View',
}

import json
import os
import queue
import tempfile
import threading
from datetime import datetime
from pathlib import Path

import bpy
import bpy.utils.previews
from bpy.props import PointerProperty, StringProperty
from . import client, exporter

_busy = False
_status = ''
_preview = None
_qr_url = ''
_alive = False
_generation = 0


class VMVPreferences(bpy.types.AddonPreferences):
    bl_idname = __package__

    server_url: StringProperty(name='配信先URL', default='https://your-worker.workers.dev')
    upload_token: StringProperty(name='管理用トークン', subtype='PASSWORD', options={'SKIP_SAVE'})
    local_connection_file: StringProperty(name='PC配信設定ファイル', subtype='FILE_PATH')

    def draw(self, context):
        self.layout.prop(self, 'local_connection_file')
        self.layout.label(text='PC配信では connection.json を指定。起動ごとのURL・トークンを自動で読み込みます。')
        column = self.layout.column()
        column.enabled = not bool(self.local_connection_file)
        column.prop(self, 'server_url')
        column.prop(self, 'upload_token')
        column.label(text='手動接続のトークンは保存されません。起動ごとに入力するか環境変数 VMV_UPLOAD_TOKEN を指定。', icon='INFO')


class VMVState(bpy.types.PropertyGroup):
    model_id: StringProperty()
    server_url: StringProperty()
    viewer_url: StringProperty()
    expires_at: StringProperty()
    dimensions_json: StringProperty()


def _preferences(context):
    prefs = context.preferences.addons[__package__].preferences
    if prefs.local_connection_file:
        try:
            path = Path(bpy.path.abspath(prefs.local_connection_file)).resolve()
            session = json.loads(path.read_text(encoding='utf-8'))
            token_path = path.parent / 'upload-token.txt'
            return client.base_url(session['serverUrl']), token_path.read_text(encoding='utf-8').strip()
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise ValueError('PC配信を起動してください。接続設定ファイルを読み込めません。') from exc
    return client.base_url(prefs.server_url), prefs.upload_token or os.environ.get('VMV_UPLOAD_TOKEN', '')


def _redraw():
    for window in bpy.context.window_manager.windows:
        for area in window.screen.areas:
            if area.type == 'VIEW_3D':
                area.tag_redraw()


def _load_qr(png, url):
    global _qr_url
    if _preview is None:
        return
    if 'qr' in _preview:
        del _preview['qr']
    with tempfile.TemporaryDirectory(prefix='vmv-qr-') as folder:
        path = Path(folder) / 'qr.png'
        path.write_bytes(png)
        # PreviewCollection.load decodes lazily, after this temporary file is gone.
        # Decode now and keep the pixels in memory for the whole preview lifetime.
        image = bpy.data.images.load(str(path), check_existing=False)
        try:
            width, height = image.size
            if not width or not height:
                raise ValueError('QRコードの画像を読み込めませんでした。')
            pixels = list(image.pixels)
            preview = _preview.new('qr')
            preview.image_size = (width, height)
            preview.image_pixels_float = pixels
        finally:
            bpy.data.images.remove(image)
    _qr_url = url


def _job(work, complete, cleanup=None):
    """Only the main-thread timer touches bpy; the network thread uses plain data."""
    global _busy, _status
    if _busy:
        return False
    _busy = True
    _status = '通信中…'
    results = queue.Queue()
    generation = _generation

    def background():
        try:
            results.put((True, work()))
        except Exception as exc:
            results.put((False, str(exc)))
        finally:
            if cleanup:
                cleanup()

    def poll():
        global _busy, _status
        if generation != _generation or not _alive:
            return None
        try:
            success, result = results.get_nowait()
        except queue.Empty:
            return 0.2 if _alive else None
        _busy = False
        if not _alive:
            return None
        try:
            if success:
                complete(result)
            else:
                _status = result
        except ReferenceError:
            _status = '通信が完了しました。シーンを開き直したため結果を反映できませんでした。'
        except Exception:
            _status = '通信は完了しましたが、表示の更新に失敗しました。QRコードを読み込み直してください。'
        _redraw()
        return None

    threading.Thread(target=background, daemon=True).start()
    bpy.app.timers.register(poll, first_interval=0.2, persistent=True)
    _redraw()
    return True


class VMV_OT_publish(bpy.types.Operator):
    bl_idname = 'vmv.publish'
    bl_label = 'ARで確認'
    bl_description = '選択モデルをアップロードして、実寸ARリンクを発行します'

    mode: StringProperty(default='NEW')
    dimensions_text: StringProperty(options={'SKIP_SAVE'})

    @classmethod
    def poll(cls, context):
        return not _busy and context.mode == 'OBJECT' and bool(context.selected_objects)

    def invoke(self, context, event):
        try:
            dimensions = exporter.measure_selection(context)
            self.dimensions_text = '幅 %.2f / 奥行 %.2f / 高さ %.2f mm' % tuple(dimensions[k] * 1000 for k in ('width', 'depth', 'height'))
            _preferences(context)
        except Exception as exc:
            self.report({'ERROR'}, str(exc))
            return {'CANCELLED'}
        return context.window_manager.invoke_props_dialog(self, width=460)

    def draw(self, context):
        self.layout.label(text='選択中のモデルをクラウドへ送信します。')
        self.layout.label(text=self.dimensions_text)
        if context.scene.unit_settings.system == 'NONE':
            self.layout.label(text='単位未設定：1 Blender単位 = 1m として送信します。', icon='INFO')
        self.layout.label(text='リンクは最終更新から24時間有効です。')

    def execute(self, context):
        global _status
        folder = None
        try:
            server, token = _preferences(context)
            if len(token) < 32:
                raise ValueError('アドオン設定で32文字以上の管理用トークンを指定してください。')
            state = context.scene.vmv_state
            # Blender releases the operator after execute returns. Async callbacks
            # must use plain values, rather than touching its expired RNA object.
            updating = self.mode == 'UPDATE'
            model_id = state.model_id if updating else ''
            if updating and (not model_id or state.server_url != server):
                raise ValueError('この配信先で発行したリンクがありません。新規送信してください。')
            folder = tempfile.TemporaryDirectory(prefix='vmv-')
            filepath = str(Path(folder.name) / 'model.glb')
            dimensions = exporter.export_selection(context, filepath)
            name = (context.active_object.name if context.active_object else 'Model')[:120]

            def work():
                result = client.publish(server, token, filepath, name, dimensions, model_id)
                try:
                    result['qr_png'] = client.fetch_qr(server, result['id'])
                except ValueError:
                    result['qr_png'] = None
                return result

            def complete(result):
                global _status
                state.model_id = result['id']
                state.server_url = server
                state.viewer_url = result['viewerUrl']
                state.expires_at = result['expiresAt']
                state.dimensions_json = json.dumps(result['dimensions'])
                if result.get('qr_png'):
                    _load_qr(result['qr_png'], state.viewer_url)
                _status = 'モデルを更新しました。端末側で開き直してください。' if updating else 'リンクを発行しました。'

            if not _job(work, complete, folder.cleanup):
                folder.cleanup()
                return {'CANCELLED'}
            return {'FINISHED'}
        except Exception as exc:
            if folder:
                folder.cleanup()
            self.report({'ERROR'}, str(exc))
            return {'CANCELLED'}


class VMV_OT_copy(bpy.types.Operator):
    bl_idname = 'vmv.copy_link'
    bl_label = 'リンクをコピー'

    def execute(self, context):
        context.window_manager.clipboard = context.scene.vmv_state.viewer_url
        self.report({'INFO'}, 'リンクをコピーしました。')
        return {'FINISHED'}


class VMV_OT_delete(bpy.types.Operator):
    bl_idname = 'vmv.delete'
    bl_label = '削除'
    bl_description = '公開リンクを無効にし、クラウド上のモデルを削除します'

    def invoke(self, context, event):
        return context.window_manager.invoke_confirm(self, event)

    def execute(self, context):
        try:
            server, token = _preferences(context)
            state = context.scene.vmv_state
            if state.server_url != server:
                raise ValueError('アドオン設定を、このリンクを発行した配信先に戻してください。')
            model_id = state.model_id

            def complete(_result):
                global _status, _qr_url
                for key in ('model_id', 'server_url', 'viewer_url', 'expires_at', 'dimensions_json'):
                    setattr(state, key, '')
                _qr_url = ''
                _status = '公開モデルを削除しました。'

            if not _job(lambda: client.delete(server, token, model_id), complete):
                return {'CANCELLED'}
            return {'FINISHED'}
        except Exception as exc:
            self.report({'ERROR'}, str(exc))
            return {'CANCELLED'}


class VMV_OT_qr(bpy.types.Operator):
    bl_idname = 'vmv.load_qr'
    bl_label = 'QRコードを表示'

    def execute(self, context):
        state = context.scene.vmv_state
        server, model_id, url = state.server_url, state.model_id, state.viewer_url
        def complete(png):
            global _status
            _load_qr(png, url)
            _status = 'QRコードを読み込みました。'
        return {'FINISHED'} if _job(lambda: client.fetch_qr(server, model_id), complete) else {'CANCELLED'}


class VMV_PT_panel(bpy.types.Panel):
    bl_label = 'VirtualModelViewer'
    bl_idname = 'VMV_PT_panel'
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category = '実寸AR'

    def draw(self, context):
        layout = self.layout
        state = context.scene.vmv_state
        layout.label(text='スマホ・Questで実寸を確認')
        row = layout.row()
        row.enabled = not _busy
        row.operator('vmv.publish', text='ARで確認（新規リンク）', icon='EXPORT').mode = 'NEW'
        if state.model_id:
            box = layout.box()
            row = box.row()
            row.enabled = False
            row.prop(state, 'viewer_url', text='URL')
            try:
                expires = datetime.fromisoformat(state.expires_at.replace('Z', '+00:00')).astimezone()
                box.label(text='有効期限：' + expires.strftime('%m/%d %H:%M'))
            except ValueError:
                pass
            if state.dimensions_json:
                try:
                    dimensions = json.loads(state.dimensions_json)
                    for key, label in [('width', '幅'), ('depth', '奥行'), ('height', '高さ')]:
                        box.label(text=f'{label}：{dimensions[key] * 1000:.2f} mm')
                except (ValueError, KeyError):
                    pass
            row = box.row()
            row.enabled = not _busy
            row.operator('vmv.publish', text='更新', icon='FILE_REFRESH').mode = 'UPDATE'
            row.operator('vmv.copy_link', icon='COPYDOWN')
            row = box.row()
            row.enabled = not _busy
            row.operator('vmv.delete', icon='TRASH')
            if _preview and 'qr' in _preview and _qr_url == state.viewer_url:
                box.template_icon(icon_value=_preview['qr'].icon_id, scale=8)
            else:
                row = box.row()
                row.enabled = not _busy
                row.operator('vmv.load_qr')
        if _status:
            # Split long Japanese messages so errors remain visible in a narrow sidebar.
            for offset in range(0, len(_status), 22):
                layout.label(text=_status[offset:offset + 22])
        prefs = context.preferences.addons[__package__].preferences
        layout.label(text='PC配信に接続（配信ソフトの起動が必要）' if prefs.local_connection_file
                     else '配信先とトークンはアドオン設定で指定', icon='PREFERENCES')


CLASSES = (VMVPreferences, VMVState, VMV_OT_publish, VMV_OT_copy, VMV_OT_delete, VMV_OT_qr, VMV_PT_panel)


def register():
    global _preview, _alive, _generation
    _generation += 1
    for cls in CLASSES:
        bpy.utils.register_class(cls)
    bpy.types.Scene.vmv_state = PointerProperty(type=VMVState)
    _preview = bpy.utils.previews.new()
    _alive = True


def unregister():
    global _preview, _alive, _busy, _qr_url, _status, _generation
    _generation += 1
    _alive = False
    _busy = False
    _qr_url = ''
    _status = ''
    if _preview is not None:
        bpy.utils.previews.remove(_preview)
        _preview = None
    del bpy.types.Scene.vmv_state
    for cls in reversed(CLASSES):
        bpy.utils.unregister_class(cls)
