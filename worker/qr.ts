import QRCode from 'qrcode';
import { zlibSync } from 'fflate';

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array) {
  const result = new Uint8Array(data.length + 12);
  const view = new DataView(result.buffer);
  view.setUint32(0, data.length);
  result.set(new TextEncoder().encode(type), 4);
  result.set(data, 8);
  view.setUint32(result.length - 4, crc32(result.subarray(4, result.length - 4)));
  return result;
}

// Small grayscale PNG encoder, without canvas or external QR services.
export function qrPng(url: string): Uint8Array {
  const qr = QRCode.create(url, { errorCorrectionLevel: 'M' });
  const scale = 4, margin = 4;
  const width = (qr.modules.size + margin * 2) * scale;
  const pixels = new Uint8Array((width + 1) * width);
  for (let y = 0; y < width; y++) {
    const moduleY = Math.floor(y / scale) - margin;
    for (let x = 0; x < width; x++) {
      const moduleX = Math.floor(x / scale) - margin;
      const dark = moduleX >= 0 && moduleY >= 0 && moduleX < qr.modules.size && moduleY < qr.modules.size && qr.modules.get(moduleY, moduleX);
      pixels[y * (width + 1) + 1 + x] = dark ? 0 : 255;
    }
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width); view.setUint32(4, width); ihdr[8] = 8;
  const chunks = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlibSync(pixels)), chunk('IEND', new Uint8Array())];
  const output = new Uint8Array(chunks.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of chunks) { output.set(part, offset); offset += part.length; }
  return output;
}
