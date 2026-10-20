// xl/styles.xml: какие стили ячеек — даты (дизайн C4d §3.4).
import { attr, parseXml } from './xml';

/** Встроенные форматы дат и времени. */
const BUILTIN_DATE_IDS = new Set<number>([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58,
]);

/** Свой формат — дата, если вне кавычек и `[...]` есть d, m+y, y, h или s. */
export function isDateFormatCode(code: string): boolean {
  const bare = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '').toLowerCase();
  return /[dyhs]/.test(bare) || (/m/.test(bare) && /y/.test(bare));
}

/** Индекс стиля (`s` ячейки) → является ли датой. */
export function parseStyles(xml: Uint8Array): boolean[] {
  const custom = new Map<number, string>();
  const xfFormat: number[] = [];
  let inCellXfs = false;
  parseXml(xml, {
    open(local, a) {
      if (local === 'numFmt') {
        const id = Number(attr(a, 'numFmtId'));
        const code = attr(a, 'formatCode');
        if (Number.isInteger(id) && code !== undefined) custom.set(id, code);
      } else if (local === 'cellXfs') inCellXfs = true;
      else if (local === 'xf' && inCellXfs) xfFormat.push(Number(attr(a, 'numFmtId') ?? 0));
    },
    close(local) {
      if (local === 'cellXfs') inCellXfs = false;
    },
  });
  return xfFormat.map((id) => {
    const code = custom.get(id);
    return code !== undefined ? isDateFormatCode(code) : BUILTIN_DATE_IDS.has(id);
  });
}
