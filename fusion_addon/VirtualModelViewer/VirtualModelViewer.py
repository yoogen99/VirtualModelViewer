"""Fusion entry point. Install the packaged ZIP (includes the shared API client)."""
import base64
import json
import os
from pathlib import Path
import queue
import tempfile
import threading
import webbrowser

import adsk.core
import adsk.fusion
from . import client, exporter, geometry, storage

COMMAND = 'VirtualModelViewer_Open'
SEND = 'VirtualModelViewer_Send'
PANEL = 'VirtualModelViewer_Panel'
PALETTE = 'VirtualModelViewer_Palette'
EVENT = 'VirtualModelViewer_NetworkCompleted'
_app = None
_ui = None
_palette = None
_handlers = []
_commands = []
_queue = queue.Queue()
_alive = False
_generation = 0
_busy = False
_status = ''
_server = ''
_token = ''
_mode = 'NEW'
_qr = ''
_qr_model = ''
_created_panel = False


def _design():
    return adsk.fusion.Design.cast(_app.activeProduct)


def _update():
    if not _palette:
        return
    model = storage.read_model(_design())
    payload = {'serverUrl': _server, 'tokenConfigured': bool(_token), 'busy': _busy,
               'status': _status, 'model': model, 'hasDesign': bool(_design()),
               'qr': _qr if _qr_model == model.get('id') else ''}
    try:
        _palette.sendInfoToHTML('state', json.dumps(payload, ensure_ascii=False))
    except RuntimeError:
        pass  # Browser may not have finished loading; its ready event retries.


def _show_palette():
    global _palette
    _palette = _ui.palettes.itemById(PALETTE)
    if not _palette:
        _palette = _ui.palettes.add(PALETTE, 'VirtualModelViewer · 実寸AR',
                                    (Path(__file__).parent / 'palette.html').as_uri(),
                                    True, True, True, 440, 720, True)
        handler = HtmlHandler()
        _palette.incomingFromHTML.add(handler)
        _handlers.append(handler)
    _palette.isVisible = True
    _update()


def _credentials():
    server = client.base_url(_server)
    if len(_token) < 32:
        raise ValueError('設定で32文字以上の管理用トークンを入力してください。')
    return server, _token


def _job(kind, design, work, cleanup=None):
    global _busy, _status
    if _busy:
        raise ValueError('通信が完了してから操作してください。')
    _busy = True
    _status = '送信中…' if kind == 'publish' else '通信中…'
    generation = _generation

    def background():
        try:
            result = (True, work())
        except Exception as exc:
            result = (False, str(exc))
        finally:
            if cleanup:
                try:
                    cleanup()
                except OSError:
                    pass
        if _alive and generation == _generation:
            _queue.put((generation, kind, design, result))
            # Fusion explicitly provides this method for cross-thread dispatch.
            # All other adsk calls occur in the main-thread event handler.
            try:
                _app.fireCustomEvent(EVENT)
            except RuntimeError:
                pass  # Add-in/application may have stopped during the request.

    threading.Thread(target=background, daemon=True).start()
    _update()


class CompletedHandler(adsk.core.CustomEventHandler):
    def notify(self, args):
        global _busy, _status, _qr, _qr_model
        try:
            while True:
                try:
                    generation, kind, design, (success, result) = _queue.get_nowait()
                except queue.Empty:
                    break
                if generation != _generation or not _alive:
                    continue
                _busy = False
                if not success:
                    _status = result
                    continue
                if kind == 'publish':
                    saved = storage.write_model(design, result)
                    _qr, _qr_model = result.get('qr', ''), result['id']
                    _status = 'リンクを発行・更新しました。端末側で開き直してください。' if saved else '元のデザインが閉じられたため記録できませんでした。URL：' + result['viewerUrl']
                elif kind == 'delete':
                    storage.clear_model(design)
                    _qr = ''; _qr_model = ''
                    _status = '公開モデルを削除しました。'
                elif kind == 'qr':
                    _qr, _qr_model = result
                    _status = 'QRコードを読み込みました。'
        except Exception:
            _busy = False
            _status = '通信結果をデザインに反映できませんでした。元のデザインを確認してください。'
        _update()


class HtmlHandler(adsk.core.HTMLEventHandler):
    def notify(self, args):
        global _server, _token, _mode, _status
        try:
            action = args.action
            data = json.loads(args.data or '{}')
            if action == 'ready' or action == 'refresh':
                _update()
                return
            if _busy:
                raise ValueError('通信が完了してから操作してください。')
            if action == 'settings':
                server = client.base_url(data.get('serverUrl', ''))
                candidate = data.get('uploadToken', '') or _token
                if len(candidate) < 32:
                    raise ValueError('32文字以上の管理用トークンを指定してください。')
                storage.save_settings(server)
                _server, _token = server, candidate
                _status = '設定を反映しました。トークンは終了時に破棄されます。'
            elif action in {'new', 'update'}:
                _credentials()
                if not _design():
                    raise ValueError('デザインを開いてください。')
                if action == 'update':
                    model = storage.read_model(_design())
                    if not model.get('id') or model.get('server') != _server:
                        raise ValueError('この配信先で発行したリンクがありません。新規リンクを発行してください。')
                _mode = 'UPDATE' if action == 'update' else 'NEW'
                _ui.commandDefinitions.itemById(SEND).execute()
            elif action == 'delete':
                design = _design()
                model = storage.read_model(design)
                server, token = _credentials()
                if not model.get('id') or model.get('server') != server:
                    raise ValueError('このリンクを発行した配信先に設定を戻してください。')
                answer = _ui.messageBox('公開リンクとモデルを削除しますか？', 'VirtualModelViewer', adsk.core.MessageBoxButtonTypes.YesNoButtonType)
                if answer == adsk.core.DialogResults.DialogYes:
                    model_id = model['id']
                    _job('delete', design, lambda: client.delete(server, token, model_id))
            elif action == 'qr':
                design = _design()
                model = storage.read_model(design)
                if not model.get('id'):
                    raise ValueError('先にリンクを発行してください。')
                server = client.base_url(model['server'])
                model_id = model['id']
                _job('qr', design, lambda: (base64.b64encode(client.fetch_qr(server, model_id)).decode('ascii'), model_id))
            elif action == 'open':
                model = storage.read_model(_design())
                if not client.ID_PATTERN.fullmatch(model.get('id', '')):
                    raise ValueError('リンクがありません。')
                webbrowser.open(f"{client.base_url(model['server'])}/v/{model['id']}")
        except Exception as exc:
            _status = str(exc)
        _update()


class OpenCreated(adsk.core.CommandCreatedEventHandler):
    def notify(self, args):
        execute = OpenExecute()
        args.command.execute.add(execute)
        handlers = [execute]
        destroy = DestroyHandler(handlers)
        handlers.append(destroy)
        args.command.destroy.add(destroy)
        _commands.append(handlers)


class OpenExecute(adsk.core.CommandEventHandler):
    def notify(self, args):
        _show_palette()


class DestroyHandler(adsk.core.CommandEventHandler):
    def __init__(self, handlers):
        super().__init__()
        self.handlers = handlers

    def notify(self, args):
        if self.handlers in _commands:
            _commands.remove(self.handlers)


class SendCreated(adsk.core.CommandCreatedEventHandler):
    def notify(self, args):
        command = args.command
        command.isExecutedWhenPreEmpted = False
        command.okButtonText = '送信してリンクを発行' if _mode == 'NEW' else 'モデルを更新'
        inputs = command.commandInputs
        selection = inputs.addSelectionInput('selection', '対象', 'ボディまたはコンポーネントを選択')
        for filter_name in ('Bodies', 'MeshBodies', 'Occurrences', 'RootComponents'):
            selection.addSelectionFilter(filter_name)
        selection.setSelectionLimits(1, 0)
        up = inputs.addDropDownCommandInput('up', 'モデルの上方向', adsk.core.DropDownStyles.TextListDropDownStyle)
        up.listItems.add('Z上向き', True); up.listItems.add('Y上向き', False)
        quality = inputs.addDropDownCommandInput('quality', 'メッシュ精度', adsk.core.DropDownStyles.TextListDropDownStyle)
        quality.listItems.add('標準', True); quality.listItems.add('高', False)
        inputs.addTextBoxCommandInput('dimensions', '送信サイズ', '対象を選択してください。', 3, True)
        inputs.addTextBoxCommandInput('note', '', 'クラウドへアップロードします。最終更新から24時間有効。<br>基本色に対応。テクスチャ・面ごとの色・アニメーションは対象外です。', 3, True)
        bundle = {'design': _design(), 'mode': _mode, 'glb': None, 'dimensions': None, 'name': ''}
        changed = SelectionChanged(bundle)
        execute = SendExecute(bundle)
        validate = ValidateSend(bundle)
        handlers = [changed, execute, validate]
        destroy = DestroyHandler(handlers)
        handlers.append(destroy)
        command.inputChanged.add(changed)
        command.execute.add(execute)
        command.validateInputs.add(validate)
        command.destroy.add(destroy)
        _commands.append(handlers)
        # Preserve the user's preselection where it matches supported entities.
        for i in range(_ui.activeSelections.count):
            entity = _ui.activeSelections.item(i).entity
            if entity.objectType.split('::')[-1] in {'BRepBody', 'MeshBody', 'Occurrence', 'Component'}:
                selection.addSelection(entity)
        changed.refresh(inputs)


class SelectionChanged(adsk.core.InputChangedEventHandler):
    def __init__(self, bundle):
        super().__init__(); self.bundle = bundle

    def refresh(self, inputs):
        self.bundle['glb'] = None
        try:
            selected = inputs.itemById('selection')
            entities = [selected.selection(i).entity for i in range(selected.selectionCount)]
            quality = adsk.fusion.TriangleMeshQualityOptions.HighQualityTriangleMesh if inputs.itemById('quality').selectedItem.index == 1 else adsk.fusion.TriangleMeshQualityOptions.NormalQualityTriangleMesh
            meshes = exporter.snapshot(self.bundle['design'], entities, quality)
            up = 'Y' if inputs.itemById('up').selectedItem.index == 1 else 'Z'
            glb, dimensions = geometry.build_glb(meshes, up)
            self.bundle.update(glb=glb, dimensions=dimensions, name=(entities[0].name if len(entities) == 1 else '選択モデル')[:120])
            inputs.itemById('dimensions').text = '幅 %.2f / 奥行 %.2f / 高さ %.2f mm\nGLB %.2f MiB' % (
                dimensions['width'] * 1000, dimensions['depth'] * 1000, dimensions['height'] * 1000, len(glb) / 1024**2)
        except Exception as exc:
            inputs.itemById('dimensions').text = str(exc)

    def notify(self, args):
        if args.input.id in {'selection', 'up', 'quality'}:
            self.refresh(args.inputs)


class ValidateSend(adsk.core.ValidateInputsEventHandler):
    def __init__(self, bundle):
        super().__init__(); self.bundle = bundle

    def notify(self, args):
        args.areInputsValid = bool(self.bundle['glb']) and not _busy


class SendExecute(adsk.core.CommandEventHandler):
    def __init__(self, bundle):
        super().__init__(); self.bundle = bundle

    def notify(self, args):
        folder = None
        try:
            if not self.bundle['glb']:
                raise ValueError('送信するモデルを選択してください。')
            server, token = _credentials()
            design = self.bundle['design']
            old = storage.read_model(design)
            model_id = old.get('id', '') if self.bundle['mode'] == 'UPDATE' else ''
            if self.bundle['mode'] == 'UPDATE' and (not model_id or old.get('server') != server):
                raise ValueError('更新先が一致しません。新しいリンクを発行してください。')
            folder = tempfile.TemporaryDirectory(prefix='vmv-fusion-')
            path = Path(folder.name) / 'model.glb'
            path.write_bytes(self.bundle['glb'])
            name, dimensions = self.bundle['name'], self.bundle['dimensions']

            def work():
                result = client.publish(server, token, str(path), name, dimensions, model_id)
                try:
                    result['qr'] = base64.b64encode(client.fetch_qr(server, result['id'])).decode('ascii')
                except ValueError:
                    result['qr'] = ''
                return result

            _job('publish', design, work, folder.cleanup)
        except Exception as exc:
            if folder:
                folder.cleanup()
            args.executeFailed = True
            args.executeFailedMessage = str(exc)


class ActivatedHandler(adsk.core.DocumentEventHandler):
    def notify(self, args):
        _update()


def run(context):
    global _app, _ui, _alive, _generation, _busy, _server, _token, _queue, _status, _created_panel
    _app = adsk.core.Application.get()
    _ui = _app.userInterface
    try:
        _generation += 1; _alive = True; _busy = False; _queue = queue.Queue()
        _server = storage.load_settings().get('serverUrl', '')
        _token = os.environ.get('VMV_UPLOAD_TOKEN', '')
        _status = '配信先を設定し、モデルを選択して送信してください。'
        completed = CompletedHandler()
        _app.registerCustomEvent(EVENT).add(completed)
        activated = ActivatedHandler()
        _app.documentActivated.add(activated)
        _handlers.extend([completed, activated])
        for identifier, label, handler in [(COMMAND, '実寸AR', OpenCreated()), (SEND, 'ARで確認', SendCreated())]:
            definition = _ui.commandDefinitions.addButtonDefinition(identifier, label, '選択したモデルをスマホ・Questで実寸確認')
            definition.commandCreated.add(handler)
            _handlers.append(handler)
        workspace = _ui.workspaces.itemById('FusionSolidEnvironment')
        panel = workspace.toolbarPanels.itemById(PANEL)
        if not panel:
            panel = workspace.toolbarPanels.add(PANEL, '実寸AR')
            _created_panel = True
        panel.controls.addCommand(_ui.commandDefinitions.itemById(COMMAND)).isPromoted = True
    except Exception:
        _ui.messageBox('VirtualModelViewerを起動できませんでした。デザイン環境とインストール内容を確認してください。')
        stop(context)


def stop(context):
    global _alive, _generation, _busy, _palette, _token, _qr, _qr_model, _created_panel
    _alive = False; _generation += 1; _busy = False
    _token = ''; _qr = ''; _qr_model = ''
    if not _ui:
        return
    try:
        workspace = _ui.workspaces.itemById('FusionSolidEnvironment')
        panel = workspace.toolbarPanels.itemById(PANEL) if workspace else None
        if panel:
            control = panel.controls.itemById(COMMAND)
            if control:
                control.deleteMe()
            if _created_panel:
                panel.deleteMe()
        palette = _ui.palettes.itemById(PALETTE)
        if palette:
            palette.deleteMe()
        for identifier in (COMMAND, SEND):
            definition = _ui.commandDefinitions.itemById(identifier)
            if definition:
                definition.deleteMe()
        _app.unregisterCustomEvent(EVENT)
        for handler in _handlers:
            if isinstance(handler, ActivatedHandler):
                _app.documentActivated.remove(handler)
    finally:
        _palette = None; _created_panel = False
        _handlers.clear(); _commands.clear()
