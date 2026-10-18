import { MAX_MODEL_BYTES, type Dimensions } from '../shared/model';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function parseMetadata(value: FormDataEntryValue | null): { name: string; dimensions: Dimensions } {
  try {
    if (typeof value !== 'string' || value.length > 4096) throw new Error();
    const data = JSON.parse(value);
    const d = data.dimensions;
    if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 120 ||
        !d || !['width', 'height', 'depth'].every(k =>
          typeof d[k] === 'number' && Number.isFinite(d[k]) && d[k] >= 0 && d[k] <= 10000) ||
        Math.max(d.width, d.height, d.depth) === 0) throw new Error();
    return { name: data.name.trim(), dimensions: { width: d.width, height: d.height, depth: d.depth } };
  } catch { throw new HttpError(400, 'モデル名とメートル単位の寸法を確認してください。'); }
}

// Container and embedded-resource validation. Renderer validation remains necessary.
export function validateGlb(bytes: ArrayBuffer): void {
  const bad = () => { throw new HttpError(400, '有効な埋め込み形式のGLB 2.0ファイルを送信してください。'); };
  if (bytes.byteLength > MAX_MODEL_BYTES) throw new HttpError(413, 'モデルの上限は25MiBです。');
  if (bytes.byteLength < 28) return bad();
  const view = new DataView(bytes);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 ||
      view.getUint32(8, true) !== bytes.byteLength) return bad();
  let offset = 12;
  let json: any;
  let binLength = 0;
  try {
    while (offset < bytes.byteLength) {
      if (offset + 8 > bytes.byteLength) return bad();
      const length = view.getUint32(offset, true);
      const type = view.getUint32(offset + 4, true);
      if (length % 4 || offset + 8 + length > bytes.byteLength) return bad();
      if (offset === 12) {
        if (type !== 0x4e4f534a) return bad();
        json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes, offset + 8, length)));
      } else if (type === 0x004e4942 && binLength === 0) {
        binLength = length;
      } else return bad();
      offset += 8 + length;
    }
    if (json?.asset?.version !== '2.0' || !json.meshes?.length || !json.nodes?.length ||
        !json.scenes?.length || json.buffers?.length !== 1 ||
        json.buffers[0].uri !== undefined || !Number.isInteger(json.buffers[0].byteLength) ||
        json.buffers[0].byteLength <= 0 || json.buffers[0].byteLength > binLength ||
        binLength - json.buffers[0].byteLength > 3) return bad();
    // No external fetches from untrusted model content, including extension URIs.
    const visit = (x: any): void => {
      if (!x || typeof x !== 'object') return;
      for (const [key, value] of Object.entries(x)) {
        if (key === 'uri' && (typeof value !== 'string' || !value.startsWith('data:'))) return bad();
        visit(value);
      }
    };
    visit(json);
    for (const b of json.bufferViews ?? []) {
      if (b.buffer !== 0 || !Number.isInteger(b.byteLength) || b.byteLength < 0 ||
          !Number.isInteger(b.byteOffset ?? 0) || (b.byteOffset ?? 0) < 0 ||
          (b.byteOffset ?? 0) + b.byteLength > json.buffers[0].byteLength) return bad();
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return bad();
  }
}
