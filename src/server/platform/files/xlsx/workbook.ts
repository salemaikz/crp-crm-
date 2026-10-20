// xl/workbook.xml и xl/_rels/workbook.xml.rels: листы и пути к ним (дизайн C4d §3.4).
import { SpreadsheetError } from '../types';
import { attr, parseXml } from './xml';

export interface WorkbookSheet {
  name: string;
  rid: string;
}

export interface WorkbookInfo {
  sheets: WorkbookSheet[];
  date1904: boolean;
}

export function parseWorkbook(xml: Uint8Array): WorkbookInfo {
  const sheets: WorkbookSheet[] = [];
  let date1904 = false;
  parseXml(xml, {
    open(local, a) {
      if (local === 'sheet') {
        const name = attr(a, 'name');
        const rid = attr(a, 'id');
        if (name !== undefined && rid !== undefined) sheets.push({ name, rid });
      } else if (local === 'workbookPr') {
        const v = attr(a, 'date1904');
        date1904 = v === '1' || v === 'true';
      }
    },
  });
  return { sheets, date1904 };
}

/** Relationship Id → Target (как записано). */
export function parseRels(xml: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  parseXml(xml, {
    open(local, a) {
      if (local !== 'Relationship') return;
      const id = attr(a, 'Id');
      const target = attr(a, 'Target');
      if (id !== undefined && target !== undefined) out.set(id, target);
    },
  });
  return out;
}

/** Путь части внутри пакета: цель относительно xl/, нормализация `..`; выход за xl/ — corrupt. */
export function resolveSheetPath(target: string): string {
  const parts: string[] = [];
  const abs = target.startsWith('/');
  const segs = (abs ? target.slice(1) : `xl/${target}`).split('/');
  for (const s of segs) {
    if (s === '' || s === '.') continue;
    if (s === '..') {
      if (parts.length === 0) throw new SpreadsheetError('corrupt');
      parts.pop();
    } else parts.push(s);
  }
  const path = parts.join('/');
  if (!path.startsWith('xl/') || path.includes('\0') || path.includes('\\')) throw new SpreadsheetError('corrupt');
  return path;
}
