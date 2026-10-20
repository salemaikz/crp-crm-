// Сборка ZIP и XLSX для тестов импорта: свой писатель на deflateRawSync (~100 строк), без зависимостей.
// Бомбы и битые архивы собираются им же с маленькими пределами в самом тесте.
import { deflateRawSync } from 'node:zlib';

export interface ZipFile {
  name: string;
  data: Uint8Array | string;
  /** 0 — хранить, 8 — deflate (по умолчанию). */
  method?: 0 | 8;
  /** Подменить объявленный несжатый размер (лживый размер, бомба). */
  declaredSize?: number;
}

const enc = new TextEncoder();
const u16 = (n: number) => Uint8Array.of(n & 255, (n >> 8) & 255);
const u32 = (n: number) => Uint8Array.of(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);
const cat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

export function zip(files: readonly ZipFile[], o: { zip64Locator?: boolean; dirOutOfFile?: boolean } = {}): Uint8Array {
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const raw = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const method = f.method ?? 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const name = enc.encode(f.name);
    const size = f.declaredSize ?? raw.length;
    const head = cat([u32(0x04034b50), u16(20), u16(0), u16(method), u16(0), u16(0), u32(0), u32(body.length), u32(size), u16(name.length), u16(0), name]);
    locals.push(head, body);
    central.push(cat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(method), u16(0), u16(0), u32(0), u32(body.length), u32(size), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name]));
    offset += head.length + body.length;
  }
  const dir = cat(central);
  const dirOffset = o.dirOutOfFile ? offset + 100_000 : offset;
  const eocd = cat([u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(dir.length), u32(dirOffset), u16(0)]);
  const locator = o.zip64Locator ? cat([u32(0x07064b50), u32(0), u32(0), u32(0), u32(1)]) : new Uint8Array(0);
  return cat([...locals, dir, locator, eocd]);
}

export type Cell = string | number | null | { date: number } | { formula: string; value?: string | number } | { bool: boolean } | { error: string };

export interface XlsxOptions {
  sheets: { name: string; rows: Cell[][]; /** r (номер строки с 1) → ячейки, для пропусков */ rowNumbers?: number[] }[];
  /** Строки через sharedStrings (по умолчанию) или inlineStr. */
  inline?: boolean;
  date1904?: boolean;
  strict?: boolean;
  /** Путь первого листа вместо xl/worksheets/sheet1.xml. */
  sheetPath?: (i: number) => string;
  /** Target в rels вместо пути листа (для проверки выхода за xl/). */
  relTarget?: (i: number) => string;
  extraFiles?: ZipFile[];
  contentTypesExtra?: string;
  doctype?: boolean;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const colName = (i: number) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

export function xlsx(o: XlsxOptions): Uint8Array {
  const NS = o.strict ? 'http://purl.oclc.org/ooxml/spreadsheetml/main' : 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const RNS = o.strict ? 'http://purl.oclc.org/ooxml/officeDocument/relationships' : 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const shared: string[] = [];
  const sharedIdx = (s: string) => {
    let i = shared.indexOf(s);
    if (i < 0) i = shared.push(s) - 1;
    return i;
  };
  const sheetXml = (rows: Cell[][], numbers: number[] | undefined) => {
    const out: string[] = [`<?xml version="1.0" encoding="UTF-8"?>`, o.doctype ? `<!DOCTYPE x [<!ENTITY a "b">]>` : '', `<worksheet xmlns="${NS}"><sheetData>`];
    rows.forEach((row, ri) => {
      const r = numbers?.[ri] ?? ri + 1;
      out.push(`<row r="${r}">`);
      row.forEach((c, ci) => {
        if (c === null || c === '') return;
        const ref = `${colName(ci)}${r}`;
        if (typeof c === 'number') out.push(`<c r="${ref}"><v>${c}</v></c>`);
        else if (typeof c === 'string') {
          if (o.inline) out.push(`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(c)}</t></is></c>`);
          else out.push(`<c r="${ref}" t="s"><v>${sharedIdx(c)}</v></c>`);
        } else if ('date' in c) out.push(`<c r="${ref}" s="1"><v>${c.date}</v></c>`);
        else if ('formula' in c) out.push(`<c r="${ref}"><f>${esc(c.formula)}</f>${c.value === undefined ? '' : `<v>${c.value}</v>`}</c>`);
        else if ('bool' in c) out.push(`<c r="${ref}" t="b"><v>${c.bool ? 1 : 0}</v></c>`);
        else out.push(`<c r="${ref}" t="e"><v>${esc(c.error)}</v></c>`);
      });
      out.push('</row>');
    });
    out.push('</sheetData></worksheet>');
    return out.join('');
  };
  const sheetFiles = o.sheets.map((s, i) => ({ path: o.sheetPath?.(i) ?? `xl/worksheets/sheet${i + 1}.xml`, xml: sheetXml(s.rows, s.rowNumbers) }));
  const workbook =
    `<?xml version="1.0"?><workbook xmlns="${NS}" xmlns:r="${RNS}"><workbookPr${o.date1904 ? ' date1904="1"' : ''}/><sheets>` +
    o.sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
    `</sheets></workbook>`;
  const rels =
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    sheetFiles.map((s, i) => `<Relationship Id="rId${i + 1}" Type="x/worksheet" Target="${o.relTarget?.(i) ?? (s.path.startsWith('/') ? s.path : s.path.replace(/^xl\//, ''))}"/>`).join('') +
    `</Relationships>`;
  const sst = `<?xml version="1.0"?><sst xmlns="${NS}">${shared.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`;
  const styles =
    `<?xml version="1.0"?><styleSheet xmlns="${NS}"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd.mm.yyyy"/></numFmts>` +
    `<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="${o.strict ? 164 : 14}"/></cellXfs></styleSheet>`;
  const contentTypes =
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    (o.contentTypesExtra ?? '') +
    `</Types>`;
  return zip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: rels },
    ...sheetFiles.map((s) => ({ name: s.path.replace(/^\//, ''), data: s.xml })),
    { name: 'xl/sharedStrings.xml', data: sst },
    { name: 'xl/styles.xml', data: styles },
    ...(o.extraFiles ?? []),
  ]);
}
