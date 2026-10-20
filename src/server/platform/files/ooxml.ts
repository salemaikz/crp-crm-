// Классификация OOXML-контейнера по составу архива и [Content_Types].xml (дизайн C4d §3.2).
// Источник идеи: платформа LMS 2cd8a2b src/lib/storage/ooxml.ts, белый список — только XLSX.
import type { ZipEntry } from './zip';

export type OoxmlKind = 'xlsx' | 'macro' | 'other';

const XLSX_MAIN = 'spreadsheetml.sheet.main+xml';

/** Запись с макросами: vbaProject.bin, activeX, макро-типы содержимого. */
export function hasMacroParts(names: readonly string[], contentTypes: string): boolean {
  const lower = names.map((n) => n.toLowerCase());
  if (lower.some((n) => n.endsWith('vbaproject.bin') || n.includes('/activex/') || n.startsWith('activex/'))) return true;
  return /macroenabled|vbaProject/i.test(contentTypes);
}

/**
 * `xlsx` — книга Excel без макросов; `macro` — XLSM и прочее с макросами; `other` — DOCX, PPTX, ODS,
 * XLSB, «и то и другое» (в архиве и Excel, и Word), любой чужой контейнер.
 */
export function classifyOoxml(entries: readonly ZipEntry[], contentTypes: string): OoxmlKind {
  const names = entries.map((e) => e.name);
  const has = (n: string) => names.includes(n);
  const isSheet = contentTypes.includes(XLSX_MAIN) && has('xl/workbook.xml');
  const foreign =
    has('word/document.xml') ||
    has('ppt/presentation.xml') ||
    has('xl/workbook.bin') ||
    has('mimetype') ||
    /wordprocessingml|presentationml|opendocument|\.binary\./i.test(contentTypes);
  if (hasMacroParts(names, contentTypes)) return has('xl/workbook.xml') && !foreign ? 'macro' : 'other';
  if (isSheet && !foreign) return 'xlsx';
  return 'other';
}
