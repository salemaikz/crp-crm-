// Потоковый разбор XML части XLSX через saxes (дизайн C4d §3.4, D-111). Весь XML строкой в куче не держим:
// байты подаются кусками по 1 МиБ через TextDecoder со `stream: true`. DOCTYPE — отказ xml_doctype
// (сущности saxes и так не раскрывает; внешних ресурсов не загружает).
import { SaxesParser, type SaxesTagPlain } from 'saxes';
import { SpreadsheetError } from '../types';

export const CHUNK_BYTES = 1024 * 1024;

export interface XmlHandlers {
  open?(local: string, attrs: Readonly<Record<string, string>>, selfClosing: boolean): void;
  close?(local: string): void;
  text?(text: string): void;
}

/** Локальная часть имени без префикса пространства имён (читаются и Strict OOXML-файлы). */
export const localName = (name: string): string => {
  const i = name.lastIndexOf(':');
  return i < 0 ? name : name.slice(i + 1);
};

/** Значение атрибута по локальной части имени (`r:id`, `id`). */
export function attr(attrs: Readonly<Record<string, string>>, local: string): string | undefined {
  if (Object.hasOwn(attrs, local)) return attrs[local];
  for (const [k, v] of Object.entries(attrs)) if (localName(k) === local) return v;
  return undefined;
}

export function parseXml(data: Uint8Array, h: XmlHandlers): void {
  const parser = new SaxesParser({ xmlns: false });
  let failure: SpreadsheetError | null = null;
  parser.on('error', () => {
    // В сообщении saxes бывает фрагмент документа: наружу — только код
    failure ??= new SpreadsheetError('corrupt');
  });
  parser.on('doctype', () => {
    failure ??= new SpreadsheetError('xml_doctype');
  });
  parser.on('opentag', (tag: SaxesTagPlain) => h.open?.(localName(tag.name), tag.attributes, tag.isSelfClosing));
  parser.on('closetag', (tag: SaxesTagPlain) => h.close?.(localName(tag.name)));
  parser.on('text', (t: string) => h.text?.(t));
  parser.on('cdata', (t: string) => h.text?.(t));
  const decoder = new TextDecoder('utf-8');
  try {
    for (let off = 0; off < data.length; off += CHUNK_BYTES) {
      const last = off + CHUNK_BYTES >= data.length;
      parser.write(decoder.decode(data.subarray(off, off + CHUNK_BYTES), { stream: !last }));
      if (failure) throw failure;
    }
    if (data.length === 0) throw new SpreadsheetError('corrupt');
    parser.close();
  } catch (e) {
    if (e instanceof SpreadsheetError) throw e;
    throw failure ?? new SpreadsheetError('corrupt');
  }
  if (failure) throw failure;
}
