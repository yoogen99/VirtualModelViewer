"""Dependency-free GLB writer. Input positions are Fusion centimeters.

Matrices are row-major local-to-world transforms, with translation in cm.
No Fusion objects are accessed here, so this module is testable without Fusion.
"""
from array import array
import json
import math
import struct
import sys

IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
MAX_BYTES = 25 * 1024 * 1024


def multiply(a, b):
    return [sum(a[r * 4 + k] * b[k * 4 + c] for k in range(4)) for r in range(4) for c in range(4)]


def _basis(v, up_axis):
    return (v[0], v[2], -v[1]) if up_axis == 'Z' else tuple(v)


def _normal_matrix(m):
    a, b, c, d, e, f, g, h, i = (m[k] for k in (0, 1, 2, 4, 5, 6, 8, 9, 10))
    determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
    if not math.isfinite(determinant) or abs(determinant) < 1e-15:
        raise ValueError('ゼロ倍率または無効な配置変換があります。')
    # Cofactor / determinant = inverse transpose.
    return [v / determinant for v in (e*i-f*h, f*g-d*i, d*h-e*g, c*h-b*i, a*i-c*g, b*g-a*h, b*f-c*e, c*d-a*f, a*e-b*d)], determinant


def _normalize(v):
    length = math.sqrt(sum(x * x for x in v))
    return tuple(x / length for x in v) if length > 1e-15 else (0, 1, 0)


def _fallback_normals(positions, indices):
    normals = [0.0] * len(positions)
    for offset in range(0, len(indices), 3):
        a, b, c = [positions[i * 3:i * 3 + 3] for i in indices[offset:offset + 3]]
        u, v = [b[i] - a[i] for i in range(3)], [c[i] - a[i] for i in range(3)]
        n = (u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0])
        for index in indices[offset:offset + 3]:
            for axis in range(3):
                normals[index * 3 + axis] += n[axis]
    return normals


def build_glb(meshes, up_axis='Z'):
    if up_axis not in {'Z', 'Y'}:
        raise ValueError('上方向はZまたはYを指定してください。')
    normalized = []
    low, high = [math.inf] * 3, [-math.inf] * 3
    for mesh in meshes:
        positions, indices = mesh['positions'], mesh['indices']
        if not positions or len(positions) % 3 or not indices or len(indices) % 3:
            raise ValueError('三角形メッシュが空、または無効です。')
        count = len(positions) // 3
        if not all(type(i) is int and 0 <= i < count for i in indices) or not all(math.isfinite(v) for v in positions):
            raise ValueError('メッシュの頂点・インデックスが無効です。')
        matrix = mesh.get('matrix', IDENTITY)
        if len(matrix) != 16 or not all(math.isfinite(v) for v in matrix):
            raise ValueError('配置変換が無効です。')
        normal_matrix, determinant = _normal_matrix(matrix)
        normals = mesh.get('normals')
        if not normals or len(normals) != len(positions):
            normals = _fallback_normals(positions, indices)
        if not all(math.isfinite(v) for v in normals):
            raise ValueError('法線が無効です。')
        used = sorted(set(indices))
        remap = {original: i for i, original in enumerate(used)}
        points, directions = [], []
        for index in used:
            point = positions[index * 3:index * 3 + 3]
            world = [sum(matrix[r * 4 + c] * point[c] for c in range(3)) + matrix[r * 4 + 3] for r in range(3)]
            point = _basis([v * 0.01 for v in world], up_axis)
            if not all(math.isfinite(v) for v in point):
                raise ValueError('変換後の頂点が無効です。')
            n = normals[index * 3:index * 3 + 3]
            direction = _normalize(_basis([sum(normal_matrix[r * 3 + c] * n[c] for c in range(3)) for r in range(3)], up_axis))
            points.extend(point); directions.extend(direction)
            for axis in range(3):
                low[axis] = min(low[axis], point[axis]); high[axis] = max(high[axis], point[axis])
        new_indices = [remap[i] for i in indices]
        if determinant < 0:
            for i in range(0, len(new_indices), 3):
                new_indices[i + 1], new_indices[i + 2] = new_indices[i + 2], new_indices[i + 1]
        color = mesh.get('color', [0.6, 0.6, 0.6, 1])
        if len(color) != 4 or not all(math.isfinite(v) and 0 <= v <= 1 for v in color):
            raise ValueError('マテリアル色が無効です。')
        normalized.append((mesh.get('name', 'Body'), points, directions, new_indices, color))
    if not normalized:
        raise ValueError('選択範囲に表示可能なメッシュがありません。')
    size = [high[i] - low[i] for i in range(3)]
    if max(size) <= 0 or max(size) > 10000:
        raise ValueError('モデルの寸法を確認してください（最大10,000m）。')
    center = ((low[0] + high[0]) / 2, low[1], (low[2] + high[2]) / 2)
    doc = {'asset': {'version': '2.0', 'generator': 'VirtualModelViewer Fusion 0.1'},
           'scene': 0, 'scenes': [{'nodes': []}], 'nodes': [], 'meshes': [], 'materials': [],
           'buffers': [], 'bufferViews': [], 'accessors': []}
    binary = bytearray()

    def append(values, kind, components, component_type, target, bounds=False):
        data = array(kind, values)
        lower = [min(data[a::3]) for a in range(3)] if bounds else None
        upper = [max(data[a::3]) for a in range(3)] if bounds else None
        if sys.byteorder != 'little':
            data.byteswap()
        offset = len(binary)
        binary.extend(data.tobytes())
        binary.extend(b'\x00' * ((-len(binary)) % 4))
        view_index = len(doc['bufferViews'])
        doc['bufferViews'].append({'buffer': 0, 'byteOffset': offset, 'byteLength': len(data) * data.itemsize, 'target': target})
        accessor = {'bufferView': view_index, 'componentType': component_type, 'count': len(values) // components,
                    'type': 'VEC3' if components == 3 else 'SCALAR'}
        if bounds:
            accessor['min'] = lower
            accessor['max'] = upper
        doc['accessors'].append(accessor)
        return len(doc['accessors']) - 1

    for name, points, normals, indices, color in normalized:
        points = [v - center[i % 3] for i, v in enumerate(points)]
        position = append(points, 'f', 3, 5126, 34962, bounds=True)
        normal = append(normals, 'f', 3, 5126, 34962)
        index = append(indices, 'I', 1, 5125, 34963)
        material = len(doc['materials'])
        doc['materials'].append({'pbrMetallicRoughness': {'baseColorFactor': color, 'metallicFactor': 0, 'roughnessFactor': 0.65},
                                 'doubleSided': True, 'alphaMode': 'BLEND' if color[3] < 1 else 'OPAQUE'})
        mesh_index = len(doc['meshes'])
        doc['meshes'].append({'name': name, 'primitives': [{'attributes': {'POSITION': position, 'NORMAL': normal}, 'indices': index, 'material': material}]})
        doc['scenes'][0]['nodes'].append(len(doc['nodes']))
        doc['nodes'].append({'mesh': mesh_index, 'name': name})
    doc['buffers'].append({'byteLength': len(binary)})
    encoded = json.dumps(doc, ensure_ascii=True, separators=(',', ':'), allow_nan=False).encode('utf8')
    encoded += b' ' * ((-len(encoded)) % 4)
    length = 12 + 8 + len(encoded) + 8 + len(binary)
    if length > MAX_BYTES:
        raise ValueError('モデルの上限は25MiBです。メッシュ精度や選択範囲を小さくしてください。')
    glb = struct.pack('<III', 0x46546c67, 2, length) + struct.pack('<II', len(encoded), 0x4e4f534a) + encoded
    glb += struct.pack('<II', len(binary), 0x004e4942) + binary
    return glb, {'width': size[0], 'height': size[1], 'depth': size[2]}
