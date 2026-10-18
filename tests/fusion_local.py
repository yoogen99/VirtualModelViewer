"""Optional packaged-Fusion GLB -> local Worker integration, without Fusion GUI.

Set VMV_TEST_SERVER to the local Worker and VMV_TEST_TOKEN to its test token.
Build the Fusion ZIP first. No production servers are accepted by this test.
"""
import importlib
import json
import os
from pathlib import Path
import sys
import tempfile
from urllib.parse import urlsplit
import zipfile

root = Path(__file__).resolve().parents[1]
server = os.environ['VMV_TEST_SERVER']
if urlsplit(server).hostname not in {'127.0.0.1','localhost','::1'}:
    raise ValueError('This integration test accepts local servers only.')
with tempfile.TemporaryDirectory(prefix='vmv-fusion-integration-') as folder:
    with zipfile.ZipFile(root/'artifacts/VirtualModelViewer-Fusion-0.1.0.zip') as archive:
        archive.extractall(folder)
    sys.path.insert(0,folder)
    geometry = importlib.import_module('VirtualModelViewer.geometry')
    client = importlib.import_module('VirtualModelViewer.client')
    # 100cm cube-like tetrahedron, in Fusion's native units.
    mesh = {'name':'Fusion 1m 基準モデル','positions':[0,0,0,100,0,0,0,100,0,0,0,100],
            'indices':[0,2,1,0,1,3,0,3,2,1,2,3],'color':[0.3,0.6,0.4,1]}
    glb, dimensions = geometry.build_glb([mesh])
    path=Path(folder)/'model.glb'; path.write_bytes(glb)
    result=client.publish(server,os.environ['VMV_TEST_TOKEN'],str(path),mesh['name'],dimensions)
    updated=client.publish(server,os.environ['VMV_TEST_TOKEN'],str(path),mesh['name'],dimensions,result['id'])
    assert result['viewerUrl']==updated['viewerUrl'] and result['revision']!=updated['revision']
    assert dimensions=={'width':1,'height':1,'depth':1}
    assert client.fetch_qr(server,result['id']).startswith(b'\x89PNG')
    client.delete(server,os.environ['VMV_TEST_TOKEN'],result['id'])
    print('PASS: packaged Fusion geometry -> publish -> update -> QR -> delete (local only).')
