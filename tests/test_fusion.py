import importlib
import json
import math
import os
from pathlib import Path
import struct
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
package = ModuleType('vmv_fusion_tests')
package.__path__ = [str(ROOT / 'fusion_addon/VirtualModelViewer')]
sys.modules[package.__name__] = package
geometry = importlib.import_module(package.__name__ + '.geometry')
exporter = importlib.import_module(package.__name__ + '.exporter')
storage = importlib.import_module(package.__name__ + '.storage')


def cube(x=100, y=100, z=100):
    return {'name': '基準ボディ', 'positions': [0,0,0, x,0,0, x,y,0, 0,y,0, 0,0,z, x,0,z, x,y,z, 0,y,z],
            'indices': [0,2,1, 0,3,2, 4,5,6, 4,6,7, 0,1,5, 0,5,4, 3,7,6, 3,6,2, 0,4,7, 0,7,3, 1,2,6, 1,6,5]}


def decode(glb):
    magic, version, total = struct.unpack_from('<III', glb)
    assert magic == 0x46546c67 and version == 2 and total == len(glb)
    length, kind = struct.unpack_from('<II', glb, 12)
    assert kind == 0x4e4f534a and length % 4 == 0
    doc = json.loads(glb[20:20 + length])
    bin_length, kind = struct.unpack_from('<II', glb, 20 + length)
    assert kind == 0x004e4942 and bin_length == doc['buffers'][0]['byteLength']
    binary = glb[28 + length:]
    def values(index):
        accessor = doc['accessors'][index]
        view = doc['bufferViews'][accessor['bufferView']]
        components = 3 if accessor['type'] == 'VEC3' else 1
        kind = 'f' if accessor['componentType'] == 5126 else 'I'
        return struct.unpack_from('<' + kind * (accessor['count'] * components), binary, view.get('byteOffset', 0))
    return doc, values


class Collection:
    def __init__(self, items=()): self.items = list(items)
    @property
    def count(self): return len(self.items)
    def item(self, index): return self.items[index]


class Component:
    objectType = 'adsk::fusion::Component'
    def __init__(self):
        self.bRepBodies = Collection(); self.meshBodies = Collection(); self.occurrences = Collection()


class Body:
    objectType = 'adsk::fusion::BRepBody'
    nativeObject = None
    assemblyContext = None
    appearance = None
    isVisible = True
    name = 'Body'
    def __init__(self, parent, mesh_body=False):
        data = cube()
        self.parentComponent = parent
        self.displayMesh = SimpleNamespace(nodeCoordinatesAsDouble=data['positions'], nodeIndices=data['indices'], normalVectorsAsDouble=[])
        self.meshManager = SimpleNamespace(createMeshCalculator=lambda: self)
        self.quality = None
        if mesh_body: self.objectType = 'adsk::fusion::MeshBody'
    def setQuality(self, quality): self.quality = quality
    def calculate(self): return self.displayMesh
    def createForAssemblyContext(self, occurrence):
        return SimpleNamespace(objectType=self.objectType, nativeObject=self, parentComponent=self.parentComponent,
                               assemblyContext=occurrence, isVisible=self.isVisible and occurrence.isVisible,
                               appearance=self.appearance)


class Occurrence:
    objectType = 'adsk::fusion::Occurrence'
    isVisible = True
    def __init__(self, path, component, matrix=None):
        self.fullPathName = path; self.component = component; self.matrix = matrix or geometry.IDENTITY[:]
        self.transform2 = SimpleNamespace(getCell=lambda r,c: self.matrix[r * 4 + c])
    def createForAssemblyContext(self, parent):
        proxy = Occurrence(parent.fullPathName + '+' + self.fullPathName, self.component, self.matrix)
        proxy.isVisible = self.isVisible and parent.isVisible
        return proxy


class GeometryTests(unittest.TestCase):
    def assert_dimensions(self, mesh, expected, axis='Z'):
        glb, dimensions = geometry.build_glb([mesh], axis)
        for key, value in expected.items(): self.assertAlmostEqual(dimensions[key], value)
        doc, values = decode(glb)
        primitive = doc['meshes'][0]['primitives'][0]
        points = values(primitive['attributes']['POSITION'])
        self.assertAlmostEqual(min(points[1::3]), 0)
        self.assertAlmostEqual(min(points[::3]) + max(points[::3]), 0)
        self.assertAlmostEqual(min(points[2::3]) + max(points[2::3]), 0)
        normals = values(primitive['attributes']['NORMAL'])
        for i in range(0, len(normals), 3): self.assertAlmostEqual(sum(v*v for v in normals[i:i+3]), 1, places=5)
        return glb

    def test_centimeters_to_100mm_and_one_meter(self):
        self.assert_dimensions(cube(10,10,10), {'width':.1,'height':.1,'depth':.1})
        self.assert_dimensions(cube(), {'width':1,'height':1,'depth':1})

    def test_z_up_and_y_up(self):
        self.assert_dimensions(cube(100,200,300), {'width':1,'height':3,'depth':2})
        self.assert_dimensions(cube(100,200,300), {'width':1,'height':2,'depth':3}, 'Y')

    def test_world_transform_rotation_and_translation(self):
        mesh = cube(100,200,300)
        mesh['matrix'] = [0,-1,0,1234, 1,0,0,-400, 0,0,1,500, 0,0,0,1]
        self.assert_dimensions(mesh, {'width':2,'height':3,'depth':1})

    def test_reflection_changes_winding_and_inverse_transpose_normals(self):
        mesh = cube(); mesh['matrix'] = [-2,0,0,0, 0,3,0,0, 0,0,4,0, 0,0,0,1]
        mesh['normals'] = [1,0,0] * 8
        glb = self.assert_dimensions(mesh, {'width':2,'height':4,'depth':3})
        doc, values = decode(glb); p = doc['meshes'][0]['primitives'][0]
        self.assertEqual(values(p['attributes']['NORMAL'])[:3], (-1,0,0))
        self.assertEqual(values(p['indices'])[:3], (0,1,2))

    def test_multiple_objects_and_unused_vertices(self):
        one, two = cube(), cube()
        one['positions'].extend([99999,99999,99999])
        two['matrix'] = geometry.IDENTITY[:]; two['matrix'][3] = 300
        glb, size = geometry.build_glb([one,two])
        self.assertEqual(size, {'width':4,'height':1,'depth':1})
        self.assertEqual(len(decode(glb)[0]['meshes']), 2)

    def test_invalid_geometry_and_size_limit(self):
        for mutate in [lambda m: m['indices'].append(999), lambda m: m['positions'].__setitem__(0, math.nan),
                       lambda m: m.update(matrix=[0]*16), lambda m: m.update(color=[2,0,0,1])]:
            mesh = cube(); mutate(mesh)
            with self.assertRaises(ValueError): geometry.build_glb([mesh])
        with self.assertRaises(ValueError): geometry.build_glb([])
        with patch.object(geometry, 'MAX_BYTES', 50), self.assertRaises(ValueError): geometry.build_glb([cube()])


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.root = Component(); self.child = Component()
        self.body = Body(self.child); self.child.bRepBodies.items.append(self.body)
        self.a = Occurrence('Part:1', self.child)
        matrix = geometry.IDENTITY[:]; matrix[3] = 300
        self.b = Occurrence('Part:2', self.child, matrix)
        self.root.occurrences.items = [self.a, self.b]
        self.design = SimpleNamespace(rootComponent=self.root)

    def test_distinct_instances_and_overlapping_selection(self):
        meshes = exporter.snapshot(self.design, [self.a,self.b], quality=7)
        self.assertEqual(len(meshes), 2); self.assertEqual(self.body.quality, 7)
        self.assertEqual(geometry.build_glb(meshes)[1]['width'], 4)
        proxy = self.body.createForAssemblyContext(self.a)
        self.assertEqual(len(exporter.snapshot(self.design,[self.a,proxy])), 1)

    def test_nested_assembly_applies_each_transform_once(self):
        self.root.occurrences.items = [self.a]
        self.a.matrix[3] = 100
        grandchild = Component(); body = Body(grandchild); grandchild.bRepBodies.items.append(body)
        matrix = geometry.IDENTITY[:]; matrix[3] = 200
        nested = Occurrence('Nested:1',grandchild,matrix)
        self.child.occurrences.items.append(nested)
        selection = nested.createForAssemblyContext(self.a)
        meshes = exporter.snapshot(self.design,[selection])
        self.assertEqual(len(meshes),1); self.assertEqual(meshes[0]['matrix'][3],300)
        self.assertEqual(body.displayMesh.nodeCoordinatesAsDouble, cube()['positions'])

    def test_hidden_instances_and_mesh_bodies(self):
        self.a.isVisible = False
        with self.assertRaises(ValueError): exporter.snapshot(self.design,[self.a])
        mesh = Body(self.root, mesh_body=True); self.root.meshBodies.items.append(mesh)
        self.assertEqual(len(exporter.snapshot(self.design,[mesh])),1)

    def test_rejects_empty_and_ambiguous_native_body(self):
        with self.assertRaises(ValueError): exporter.snapshot(self.design,[])
        with self.assertRaises(ValueError): exporter.snapshot(self.design,[self.body])


class Attributes:
    def __init__(self): self.item_value = None
    def itemByName(self, group, key): return self.item_value
    def add(self, group, key, value):
        self.item_value = SimpleNamespace(value=value, deleteMe=lambda: setattr(self,'item_value',None))
        return self.item_value


class StorageTests(unittest.TestCase):
    def test_only_writes_model_metadata_to_originating_valid_design(self):
        design = SimpleNamespace(isValid=True, rootComponent=SimpleNamespace(attributes=Attributes()))
        data = {'id':'a'*48, 'server':'https://viewer.example', 'uploadToken':'SECRET', 'qr':'PNG'}
        self.assertTrue(storage.write_model(design,data))
        self.assertEqual(storage.read_model(design), {'id':data['id'],'server':data['server']})
        self.assertTrue(storage.clear_model(design)); self.assertEqual(storage.read_model(design),{})
        design.isValid=False; self.assertFalse(storage.write_model(design,data))

    def test_settings_store_endpoint_without_credentials(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ,{'VMV_FUSION_SETTINGS':str(Path(folder)/'settings.json')}):
            storage.save_settings('https://viewer.example')
            self.assertEqual(storage.load_settings(),{'serverUrl':'https://viewer.example'})


class CompletionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Test lifecycle behavior without opening or driving the user's Fusion.
        adsk = ModuleType('adsk'); adsk.core = ModuleType('adsk.core'); adsk.fusion = ModuleType('adsk.fusion')
        for name in ('CustomEventHandler','HTMLEventHandler','CommandCreatedEventHandler','CommandEventHandler',
                     'InputChangedEventHandler','ValidateInputsEventHandler','DocumentEventHandler'):
            setattr(adsk.core,name,type(name,(),{}))
        adsk.fusion.Design = SimpleNamespace(cast=lambda value:value)
        client = ModuleType(package.__name__ + '.client')
        with patch.dict(sys.modules,{'adsk':adsk,'adsk.core':adsk.core,'adsk.fusion':adsk.fusion,client.__name__:client}):
            cls.ui = importlib.import_module(package.__name__ + '.VirtualModelViewer')

    def setUp(self):
        self.original = SimpleNamespace(isValid=True,rootComponent=SimpleNamespace(attributes=Attributes()))
        self.active = SimpleNamespace(isValid=True,rootComponent=SimpleNamespace(attributes=Attributes()))
        self.ui._app = SimpleNamespace(activeProduct=self.active)
        self.ui._palette = None; self.ui._generation=5; self.ui._alive=True; self.ui._busy=True
        self.ui._queue=self.ui.queue.Queue()

    def complete(self, result, generation=5):
        self.ui._queue.put((generation,'publish',self.original,result))
        self.ui.CompletedHandler().notify(None)

    def test_document_switch_does_not_attach_result_to_another_design(self):
        self.complete((True,{'id':'a'*48,'viewerUrl':'https://viewer.example/v/test'}))
        self.assertEqual(storage.read_model(self.original)['id'],'a'*48)
        self.assertEqual(storage.read_model(self.active),{})

    def test_closed_document_and_old_generation_are_not_modified(self):
        self.original.isValid=False
        self.complete((True,{'id':'a'*48,'viewerUrl':'https://viewer.example/v/test'}))
        self.assertIn('https://viewer.example/v/test',self.ui._status)
        self.assertEqual(storage.read_model(self.active),{})
        self.original.isValid=True
        self.complete((True,{'id':'b'*48}),generation=4)
        self.assertEqual(storage.read_model(self.original),{})

    def test_failed_update_keeps_the_previous_link(self):
        storage.write_model(self.original,{'id':'a'*48})
        self.complete((False,'network failed'))
        self.assertEqual(storage.read_model(self.original)['id'],'a'*48)
        self.assertFalse(self.ui._busy)

    def test_published_url_survives_attribute_write_failure(self):
        with patch.object(storage,'write_model',side_effect=RuntimeError('document unavailable')):
            self.complete((True,{'id':'a'*48,'viewerUrl':'https://viewer.example/v/test'}))
        self.assertIn('https://viewer.example/v/test',self.ui._status)
        self.assertEqual(storage.read_model(self.active),{})

    def test_preselection_is_adopted_at_activation_and_only_once(self):
        selected = SimpleNamespace(selectionCount=0, addSelection=Mock())
        inputs = SimpleNamespace(itemById=lambda key:selected)
        changed = SimpleNamespace(refresh=Mock())
        entity = SimpleNamespace(objectType='adsk::fusion::BRepBody')
        activation = self.ui.SendActivated(inputs,[entity],changed)
        selected.addSelection.assert_not_called()
        activation.notify(None); activation.notify(None)
        selected.addSelection.assert_called_once_with(entity)
        selected.selectionCount=1; selected.addSelection.reset_mock()
        self.ui.SendActivated(inputs,[entity],changed).notify(None)
        selected.addSelection.assert_not_called()


if __name__ == '__main__': unittest.main()
