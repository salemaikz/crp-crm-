// Ключ строки и ключ состояния импорта (D-048, PROCESS 12.14).
//  - ключ строки = профиль + хэш опознающих полей (нормализованное название, номера, руководитель,
//    код формы собственности, если известна — D-143), без имени и хэша файла: тот же человек в другом
//    файле — та же строка, а «ТОО Альфа» и «ИП Альфа» с общим номером — разные строки;
//  - ключ состояния = хэш колонок итога, ЛПР, статуса, ниши, заметки;
//  - `import_key` звонка = ключ строки + ключ состояния.
// Номер один как ключ не годится: в таблицах 45 номеров общие у разных компаний.

import type { KeyHashFn } from './types';

const SEP = '\u001f';

/** Пробелы по краям и повторные пробелы не меняют ключ состояния (≈ 2,5 % заметок с хвостовыми пробелами). */
export function squashSpaces(s: string): string {
  return (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export interface RowIdentity {
  nameNorm: string;
  headNorm: string;
  /** Рабочие номера (канон) и цифры заглушек: порядок в ячейке значения не имеет. */
  workingPhones: readonly string[];
  stubPhones: readonly string[];
  /** Код формы собственности (`тоо`, `ип`); пусто — не входит в ключ (ключи строк без формы не меняются). */
  legalForm?: string;
}

export function rowKeyOf(profileKey: string, id: RowIdentity, hash: KeyHashFn): string {
  const phones = [...new Set([...id.workingPhones, ...id.stubPhones.map((p) => `~${p}`)])].sort();
  const parts = [id.nameNorm, phones.join(','), id.headNorm];
  if (id.legalForm) parts.push(id.legalForm);
  return `${profileKey}:${hash(parts.join(SEP))}`;
}

export function stateKeyOf(fields: Readonly<Record<string, string>>, stateFields: readonly string[], hash: KeyHashFn): string {
  return hash(stateFields.map((f) => squashSpaces(fields[f] ?? '')).join(SEP));
}

/** Ключ импортного звонка: `calls.import_key` (UNIQUE). Та же пара ключей → пропуск. */
export const importKeyOf = (rowKey: string, stateKey: string): string => `${rowKey}:${stateKey}`;
