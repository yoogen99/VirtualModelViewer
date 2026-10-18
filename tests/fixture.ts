export function triangleGlb(): Uint8Array {
  const data = {
    asset: { version: '2.0' }, scene: 0,
    scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: 36 }], bufferViews: [{ buffer: 0, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
  };
  const text = JSON.stringify(data);
  const encoded = new TextEncoder().encode(text.padEnd(Math.ceil(text.length / 4) * 4, ' '));
  const result = new Uint8Array(12 + 8 + encoded.length + 8 + 36);
  const view = new DataView(result.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, result.length, true);
  view.setUint32(12, encoded.length, true); view.setUint32(16, 0x4e4f534a, true); result.set(encoded, 20);
  const start = 20 + encoded.length;
  view.setUint32(start, 36, true); view.setUint32(start + 4, 0x004e4942, true);
  new Float32Array(result.buffer, start + 8).set([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  return result;
}
