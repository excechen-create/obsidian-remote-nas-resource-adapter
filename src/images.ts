import { AdapterError } from './errors';
export interface ImageData { bytes: ArrayBuffer; mime: string }
export function checkedImage(bytes: ArrayBuffer, contentType: string, limit: number): ImageData {
  if (!bytes.byteLength || bytes.byteLength > limit) throw new AdapterError('TOO_LARGE');
  const b = new Uint8Array(bytes);
  let mime: string | undefined;
  if ([137,80,78,71,13,10,26,10].every((v,i) => b[i] === v)) mime = 'image/png';
  else if (b[0] === 255 && b[1] === 216 && b[2] === 255) mime = 'image/jpeg';
  else if (String.fromCharCode(...b.slice(0,4)) === 'RIFF' && String.fromCharCode(...b.slice(8,12)) === 'WEBP') mime = 'image/webp';
  const declared = contentType.split(';')[0]?.trim().toLowerCase();
  if (!mime || (declared !== mime && declared !== 'application/octet-stream')) throw new AdapterError('IMAGE');
  return { bytes, mime };
}
