"""Snapshot selected evaluated geometry without editing the source scene."""
import math
import bpy
from mathutils import Matrix, Vector

SUPPORTED = {'MESH', 'CURVE', 'SURFACE', 'FONT', 'META'}


def _snapshots(context):
    if context.mode != 'OBJECT':
        raise ValueError('オブジェクトモードで送信してください。')
    selected = {obj for obj in context.selected_objects if obj.visible_get()}
    if not selected:
        raise ValueError('表示中のモデルを選択してください。')
    depsgraph = context.evaluated_depsgraph_get()
    meshes = []
    try:
        for instance in depsgraph.object_instances:
            original = instance.object.original
            parent = instance.parent.original if instance.parent else None
            if (not instance.is_instance and original not in selected) or (
                    instance.is_instance and parent not in selected):
                continue
            if original.type not in SUPPORTED:
                continue
            mesh = bpy.data.meshes.new_from_object(instance.object, preserve_all_data_layers=True, depsgraph=depsgraph)
            if not mesh:
                continue
            if not mesh.polygons:
                bpy.data.meshes.remove(mesh)
                continue
            meshes.append(mesh)
            mesh.transform(instance.matrix_world)
            if instance.matrix_world.determinant() < 0:
                mesh.flip_normals()
        if not meshes:
            raise ValueError('選択範囲に送信できる形状がありません。')
        return meshes
    except Exception:
        for mesh in meshes:
            bpy.data.meshes.remove(mesh)
        raise


def _bounds(meshes, scale):
    low = Vector((math.inf,) * 3)
    high = Vector((-math.inf,) * 3)
    for mesh in meshes:
        # glTF omits loose vertices/edges; they must not inflate AR dimensions.
        used = {index for polygon in mesh.polygons for index in polygon.vertices}
        for index in used:
            vertex = mesh.vertices[index]
            point = vertex.co * scale
            if not all(math.isfinite(v) for v in point):
                raise ValueError('モデルに無効な頂点座標があります。')
            for axis in range(3):
                low[axis] = min(low[axis], point[axis])
                high[axis] = max(high[axis], point[axis])
    size = high - low
    if max(size) <= 0 or max(size) > 10000:
        raise ValueError('モデルの寸法を確認してください（最大10,000m）。')
    dimensions = {'width': size.x, 'depth': size.y, 'height': size.z}
    center = Vector(((low.x + high.x) / 2, (low.y + high.y) / 2, low.z))
    return dimensions, center


def unit_scale(scene):
    return scene.unit_settings.scale_length if scene.unit_settings.system != 'NONE' else 1.0


def measure_selection(context):
    meshes = _snapshots(context)
    try:
        return _bounds(meshes, unit_scale(context.scene))[0]
    finally:
        for mesh in meshes:
            bpy.data.meshes.remove(mesh)


def export_selection(context, filepath):
    scale = unit_scale(context.scene)
    meshes = _snapshots(context)
    scene = None
    objects = []
    try:
        dimensions, center = _bounds(meshes, scale)
        scene = bpy.data.scenes.new('VMV_Export_Temporary')
        scene.unit_settings.system = 'METRIC'
        scene.unit_settings.scale_length = 1.0
        transform = Matrix.Translation(-center) @ Matrix.Scale(scale, 4)
        for i, mesh in enumerate(meshes):
            mesh.transform(transform)
            obj = bpy.data.objects.new(f'Model_{i + 1}', mesh)
            objects.append(obj)
            scene.collection.objects.link(obj)
        layer = scene.view_layers[0]
        with context.temp_override(scene=scene, view_layer=layer):
            result = bpy.ops.export_scene.gltf(
                filepath=filepath, export_format='GLB', use_selection=False,
                use_active_scene=True, export_animations=False, export_cameras=False,
                export_lights=False, export_apply=False, export_yup=True,
                export_extras=False,
            )
            if 'FINISHED' not in result:
                raise ValueError('GLBを書き出せませんでした。')
        return dimensions
    finally:
        for obj in objects:
            bpy.data.objects.remove(obj, do_unlink=True)
        if scene:
            bpy.data.scenes.remove(scene)
        for mesh in meshes:
            bpy.data.meshes.remove(mesh)
