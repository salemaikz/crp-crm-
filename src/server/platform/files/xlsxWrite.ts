// XLSX из таблицы выгрузки (дизайн R3b §2.2, D-263): свой писатель без зависимостей. Строки — только `inlineStr`,
// элементов `<f>` нет вообще; строка, похожая на формулу, получает стиль с `quotePrefix="1"` — формула не исполнится
// и после пересохранения. Числа — `<v>` со стилем по типу колонки. Одна книга — один лист, первая строка закреплена.
import { looksLikeFormula } from './csvExport';
import { collectStream, createZipWriter } from './zipWrite';

export const XLSX_MAX_ROWS = 100_000;
export const XLSX_MAX_CELL_CHARS = 32_767;

export type XlsxColumnType = 'text' | 'int' | 'money' | 'percent' | 'day';

/** Таблица для листа: тот же вид, что ExportTable домена отчётов (платформа домен не импортирует). */
export interface XlsxTable {
  columns: readonly { label: string; type: XlsxColumnType }[];
  rows: readonly (readonly (string | number | null)[])[];
}

export class XlsxWriteError extends Error {
  constructor(readonly code: 'too_many_rows') {
    super(`xlsx:${code}`);
    this.name = 'XlsxWriteError';
  }
}

/** Индексы стилей `cellXfs` (styles.xml ниже). */
const STYLE = { plain: 0, header: 1, quoted: 2, money: 3, percent: 4 } as const;

const WIDTH: Record<XlsxColumnType, number> = { text: 28, day: 12, int: 11, money: 15, percent: 10 };

/** Символы, запрещённые в XML 1.0 (и одиночные суррогаты), вырезаются. */
const XML_FORBIDDEN = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;

export function xmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&apos;'));
}

/** Текст ячейки: без запрещённых символов, не длиннее предела Excel (обрезка с «…», пара суррогатов не рвётся). */
export function cellText(raw: string): string {
  const s = raw.replace(XML_FORBIDDEN, '');
  if (s.length <= XLSX_MAX_CELL_CHARS) return s;
  let cut = XLSX_MAX_CELL_CHARS - 1;
  const code = s.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut--;
  return `${s.slice(0, cut)}…`;
}

/** Номер колонки с 0 → буквы (`0 → A`, `26 → AA`). */
export function columnName(i: number): string {
  let n = i + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Имя листа: без `[]:*?/\`, не длиннее 31 символа, не пустое. */
export function sheetNameOf(raw: string): string {
  const s = cellText(raw).replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31).trim();
  return s === '' ? 'Sheet1' : s;
}

function stringCell(ref: string, raw: string, style: number): string {
  const text = cellText(raw);
  const s = looksLikeFormula(text) ? STYLE.quoted : style;
  const space = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : '';
  return `<c r="${ref}" t="inlineStr"${s ? ` s="${s}"` : ''}><is><t${space}>${xmlEscape(text)}</t></is></c>`;
}

function cell(ref: string, v: string | number | null, type: XlsxColumnType): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '';
    const s = type === 'money' ? STYLE.money : type === 'percent' ? STYLE.percent : STYLE.plain;
    // в текстовой колонке число остаётся числом: так его видит и CSV
    return `<c r="${ref}"${s ? ` s="${s}"` : ''}><v>${v}</v></c>`;
  }
  return stringCell(ref, String(v), STYLE.plain);
}

const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

const CONTENT_TYPES =
  HEAD +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
  '</Types>';

const ROOT_RELS =
  HEAD +
  `<Relationships xmlns="${NS_PKG_REL}">` +
  `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/>` +
  '</Relationships>';

const WORKBOOK_RELS =
  HEAD +
  `<Relationships xmlns="${NS_PKG_REL}">` +
  `<Relationship Id="rId1" Type="${NS_REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
  `<Relationship Id="rId2" Type="${NS_REL}/styles" Target="styles.xml"/>` +
  '</Relationships>';

// Стили: 0 обычный, 1 заголовок (жирный), 2 текст с quotePrefix, 3 деньги `#,##0` (встроенный 3), 4 проценты `0.0`
const STYLES =
  HEAD +
  `<styleSheet xmlns="${NS_MAIN}">` +
  '<numFmts count="1"><numFmt numFmtId="164" formatCode="0.0"/></numFmts>' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="5">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" quotePrefix="1"/>' +
  '<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

function workbookXml(sheetName: string): string {
  return HEAD + `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheets><sheet name="${xmlEscape(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
}

const encoder = new TextEncoder();

/** Лист кусками по 500 строк: большой XML не собирается одной строкой. */
async function* sheetXml(t: XlsxTable): AsyncGenerator<Uint8Array> {
  const cols = t.columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${WIDTH[c.type]}" customWidth="1"/>`).join('');
  let buf =
    HEAD +
    `<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    (cols ? `<cols>${cols}</cols>` : '') +
    '<sheetData>';
  buf += `<row r="1">${t.columns.map((c, i) => stringCell(`${columnName(i)}1`, c.label, STYLE.header)).join('')}</row>`;
  for (let r = 0; r < t.rows.length; r++) {
    const row = t.rows[r] as readonly (string | number | null)[];
    const n = r + 2;
    let cells = '';
    for (let i = 0; i < t.columns.length; i++) cells += cell(`${columnName(i)}${n}`, row[i] ?? null, (t.columns[i] as { type: XlsxColumnType }).type);
    buf += `<row r="${n}">${cells}</row>`;
    if (r % 500 === 499) {
      yield encoder.encode(buf);
      buf = '';
    }
  }
  buf += '</sheetData></worksheet>';
  yield encoder.encode(buf);
}

/** Книга с одним листом. Строк больше XLSX_MAX_ROWS — XlsxWriteError('too_many_rows') (маршрут: 413). */
export async function writeXlsx(t: { sheetName: string; table: XlsxTable }): Promise<Uint8Array> {
  if (t.table.rows.length > XLSX_MAX_ROWS) throw new XlsxWriteError('too_many_rows');
  const zip = createZipWriter();
  // читать поток надо одновременно с записью: иначе противодавление остановит запись
  const collected = collectStream(zip.stream);
  try {
    await zip.addFile('[Content_Types].xml', encoder.encode(CONTENT_TYPES));
    await zip.addFile('_rels/.rels', encoder.encode(ROOT_RELS));
    await zip.addFile('xl/workbook.xml', encoder.encode(workbookXml(sheetNameOf(t.sheetName))));
    await zip.addFile('xl/_rels/workbook.xml.rels', encoder.encode(WORKBOOK_RELS));
    await zip.addFile('xl/styles.xml', encoder.encode(STYLES));
    await zip.addFile('xl/worksheets/sheet1.xml', sheetXml(t.table));
    await zip.finish();
  } catch (e) {
    zip.abort('xlsx');
    await collected.catch(() => undefined);
    throw e;
  }
  return collected;
}
