"""Read-only Fusion geometry adapter. No adsk calls are made off the main thread."""
from .geometry import IDENTITY, multiply


def _items(collection):
    return (collection.item(i) for i in range(collection.count))


def _kind(entity):
    return entity.objectType.split('::')[-1]


def _color(entity):
    appearance = entity.appearance
    if appearance:
        for key in ('generic_diffuse', 'opaque_albedo', 'metal_f0', 'surface_albedo'):
            prop = appearance.appearanceProperties.itemById(key)
            if prop and prop.objectType.endswith('::ColorProperty'):
                color = prop.value
                def linear(v):
                    v = v / 255.0
                    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
                return [linear(color.red), linear(color.green), linear(color.blue), color.opacity / 255.0]
    return [0.6, 0.6, 0.6, 1]


def snapshot(design, entities, quality=None):
    """Resolve selections through the root assembly, applying native transforms once.

    Body comparisons use Fusion's object equality, not saved entity-token strings.
    Occurrence paths distinguish repeated instances of the same component.
    """
    selected_paths, selected_bodies, include_root = set(), [], False
    for entity in entities:
        kind = _kind(entity)
        if kind == 'Occurrence':
            selected_paths.add(entity.fullPathName)
        elif kind in {'BRepBody', 'MeshBody'}:
            context = entity.assemblyContext
            native = entity.nativeObject or entity
            if not context and native.parentComponent != design.rootComponent:
                raise ValueError('このボディはコンポーネントの配置インスタンスを選択して送信してください。')
            selected_bodies.append((native, context.fullPathName if context else ''))
        elif kind == 'Component' and entity == design.rootComponent:
            include_root = True
        else:
            raise ValueError('ボディまたはコンポーネントの配置インスタンスを選択してください。')
    if not entities:
        raise ValueError('送信するボディまたはコンポーネントを選択してください。')
    records = []

    def visit(component, matrix, occurrence=None, parent_selected=False):
        path = occurrence.fullPathName if occurrence else ''
        if occurrence and not occurrence.isVisible:
            return
        selected = parent_selected or path in selected_paths
        for bodies in (component.bRepBodies, component.meshBodies):
            for body in _items(bodies):
                if not selected and not any(body == native and path == selected_path for native, selected_path in selected_bodies):
                    continue
                contextual = body.createForAssemblyContext(occurrence) if occurrence else body
                if not contextual or not contextual.isVisible:
                    continue
                if _kind(body) == 'BRepBody':
                    calculator = body.meshManager.createMeshCalculator()
                    if not calculator:
                        raise ValueError('メッシュ計算を開始できませんでした。')
                    if quality is not None:
                        calculator.setQuality(quality)
                    mesh = calculator.calculate()
                else:
                    mesh = body.displayMesh
                if not mesh or not mesh.nodeIndices:
                    continue
                records.append({'name': body.name, 'positions': list(mesh.nodeCoordinatesAsDouble),
                                'normals': list(mesh.normalVectorsAsDouble), 'indices': list(mesh.nodeIndices),
                                'color': _color(contextual), 'matrix': list(matrix)})
        # component.occurrences supplies native child transforms. Multiplying
        # them explicitly avoids applying assembly-context proxy transforms twice.
        for child in _items(component.occurrences):
            contextual = child.createForAssemblyContext(occurrence) if occurrence else child
            local = [child.transform2.getCell(r, c) for r in range(4) for c in range(4)]
            visit(child.component, multiply(matrix, local), contextual, selected)

    visit(design.rootComponent, IDENTITY, parent_selected=include_root)
    if not records:
        raise ValueError('選択範囲に表示中のメッシュがありません。非表示状態も確認してください。')
    return records
