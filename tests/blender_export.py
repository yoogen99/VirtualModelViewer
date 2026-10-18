"""Run with blender --background --factory-startup --python tests/blender_export.py."""
import json
import math
import os
import struct
import sys
import tempfile
from pathlib import Path

import bpy
from mathutils import Matrix, Quaternion, Vector

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'blender_addon'))
import virtual_model_viewer as addon
from virtual_model_viewer import exporter, client


def glb_points(path):
    data = Path(path).read_bytes()
    size, kind = struct.unpack_from('<II', data, 12)
    assert kind == 0x4e4f534a
    doc = json.loads(data[20:20 + size])
    binary = data[28 + size:]
    points = []

    def walk(index, parent):
        node = doc['nodes'][index]
        if 'matrix' in node:
            local = Matrix([node['matrix'][i:i + 4] for i in range(0, 16, 4)]).transposed()
        else:
            q = node.get('rotation', [0, 0, 0, 1])
            local = Matrix.LocRotScale(Vector(node.get('translation', [0, 0, 0])),
                                       Quaternion((q[3], q[0], q[1], q[2])),
                                       Vector(node.get('scale', [1, 1, 1])))
        world = parent @ local
        if 'mesh' in node:
            for primitive in doc['meshes'][node['mesh']]['primitives']:
                accessor = doc['accessors'][primitive['attributes']['POSITION']]
                assert accessor['componentType'] == 5126 and accessor['type'] == 'VEC3'
                view = doc['bufferViews'][accessor['bufferView']]
                start = view.get('byteOffset', 0) + accessor.get('byteOffset', 0)
                for i in range(accessor['count']):
                    point = Vector(struct.unpack_from('<fff', binary, start + i * view.get('byteStride', 12)))
                    points.append(world @ point)
        for child in node.get('children', []):
            walk(child, world)

    for index in doc['scenes'][doc.get('scene', 0)]['nodes']:
        walk(index, Matrix.Identity(4))
    return points


def reset(system='METRIC', scale=1):
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    bpy.context.scene.unit_settings.system = system
    bpy.context.scene.unit_settings.scale_length = scale


def cube(size=1, location=(0, 0, 0), scale=(1, 1, 1)):
    bpy.ops.mesh.primitive_cube_add(size=size, location=location)
    obj = bpy.context.object
    obj.scale = scale
    bpy.context.view_layer.update()
    return obj


def verify(path, expected):
    original_scene = bpy.context.scene
    selected = list(bpy.context.selected_objects)
    matrices = {obj: obj.matrix_world.copy() for obj in selected}
    counts = (len(bpy.data.objects), len(bpy.data.meshes), len(bpy.data.scenes))
    measured = exporter.measure_selection(bpy.context)
    dimensions = exporter.export_selection(bpy.context, path)
    for key, value in expected.items():
        assert math.isclose(measured[key], value, rel_tol=1e-5, abs_tol=1e-6), (measured, expected)
        assert math.isclose(dimensions[key], value, rel_tol=1e-5, abs_tol=1e-6), (dimensions, expected)
    points = glb_points(path)
    low = [min(p[i] for p in points) for i in range(3)]
    high = [max(p[i] for p in points) for i in range(3)]
    for axis, key in enumerate(('width', 'height', 'depth')):
        assert math.isclose(high[axis] - low[axis], expected[key], rel_tol=1e-5, abs_tol=1e-6), (low, high, expected)
    assert abs(low[1]) < 1e-5, ('bottom', low)
    assert abs(low[0] + high[0]) < 1e-5 and abs(low[2] + high[2]) < 1e-5
    assert bpy.context.scene == original_scene
    assert set(bpy.context.selected_objects) == set(selected)
    assert counts == (len(bpy.data.objects), len(bpy.data.meshes), len(bpy.data.scenes))
    assert all(obj.matrix_world == matrices[obj] for obj in selected)
    return dimensions


with tempfile.TemporaryDirectory(prefix='vmv-tests-') as folder:
    path = str(Path(folder) / 'reference.glb')
    reset(); cube(0.1)
    verify(path, dict(width=0.1, height=0.1, depth=0.1))
    reset(); cube(1, location=(12, -4, 7), scale=(1, 2, 3))
    verify(path, dict(width=1, height=3, depth=2))
    reset(scale=0.001); cube(100)
    verify(path, dict(width=0.1, height=0.1, depth=0.1))
    reset(scale=0.001); cube(1000)
    verify(path, dict(width=1, height=1, depth=1))
    reset(system='NONE', scale=0.001); cube(1)
    verify(path, dict(width=1, height=1, depth=1))
    reset(); one = cube(1, location=(-1, 0, 3)); two = cube(1, location=(1, 0, 3))
    one.select_set(True)
    verify(path, dict(width=3, height=1, depth=1))
    reset(); obj = cube(1, scale=(-1, 2, 1)); obj.rotation_euler.z = math.pi / 2
    bpy.context.view_layer.update()
    verify(path, dict(width=2, height=1, depth=1))
    reset(); obj = cube(1)
    modifier = obj.modifiers.new('Array', 'ARRAY'); modifier.count = 2
    bpy.context.view_layer.update()
    verify(path, dict(width=2, height=1, depth=1))
    reset(); obj = cube(1); obj.select_set(False)
    try:
        exporter.measure_selection(bpy.context)
        raise AssertionError('empty selection accepted')
    except ValueError:
        pass
    reset(); obj = cube(1)
    addon.register()
    bpy.context.scene.vmv_state.viewer_url = 'https://viewer.example/v/test'
    assert bpy.context.scene.vmv_state.viewer_url.endswith('/test')
    addon.unregister()

    # Optional end-to-end test: Blender export -> Python client -> local Worker.
    if os.environ.get('VMV_TEST_SERVER'):
        reset(); obj = cube(1, location=(0, 0, 0.5))
        obj.name = '1m 基準キューブ'
        material = bpy.data.materials.new('基準カラー')
        material.diffuse_color = (0.38, 0.6, 0.28, 1)
        material.use_nodes = True
        material.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value = (0.38, 0.6, 0.28, 1)
        obj.data.materials.append(material)
        dimensions = verify(path, dict(width=1, height=1, depth=1))
        server = os.environ['VMV_TEST_SERVER']
        token = os.environ['VMV_TEST_TOKEN']
        result = client.publish(server, token, path, obj.name, dimensions)
        qr = client.fetch_qr(server, result['id'])
        assert qr.startswith(b'\x89PNG')
        updated = client.publish(server, token, path, obj.name, dimensions, result['id'])
        assert updated['viewerUrl'] == result['viewerUrl'] and updated['revision'] != result['revision']
        Path(ROOT / 'artifacts').mkdir(exist_ok=True)
        Path(ROOT / 'artifacts' / 'local-model.json').write_text(json.dumps(updated), encoding='utf8')
        print('LOCAL_VIEWER_URL=' + result['viewerUrl'])

print('PASS: 8 geometry cases, empty selection, addon registration; source scene unchanged.')
