// Тело запроса в память с жёстким пределом (дизайн C4d §3.1, D-112). multipart не поддерживается:
// Next читает его целиком без предела, поэтому файл приходит сырым телом application/octet-stream.
import { SpreadsheetError } from './types';

export async function readBodyLimited(req: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = req.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    // тело не читаем; закрываем поток, чтобы не держать соединение
    await req.body?.cancel().catch(() => {});
    throw new SpreadsheetError('too_large');
  }
  if (!req.body) throw new SpreadsheetError('empty');
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new SpreadsheetError('too_large');
    }
    chunks.push(value);
  }
  if (total === 0) throw new SpreadsheetError('empty');
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}
