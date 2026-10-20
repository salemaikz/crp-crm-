// Типы импорта таблиц (PROCESS 2.2, 3.7, 12.14; CONFIG 6.13; D-048).
// Вход — таблица как массив строк (CSV; разбор XLSX — отдельная зависимость и вне ядра).
// Номера строк — как в таблице: 1 — первая строка файла (баннер или заголовки), данные идут ниже.

import type { NormalizedPhone } from '../dedup/types';

/** Ключи полей, которые знает импорт; профиль сопоставляет с ними заголовки колонок. */
export const IMPORT_FIELDS = {
  legalForm: 'legalForm',
  name: 'name',
  region: 'region',
  head: 'head',
  activity: 'activity',
  phones: 'phones',
  address: 'address',
  orgId: 'orgId',
  operator: 'operator',
  outcome: 'outcome',
  lpr: 'lpr',
  status: 'status',
  niche: 'niche',
  note: 'note',
} as const;

/** Поля «состояния» строки по умолчанию: итог, ЛПР, статус, ниша, заметка (D-048). */
export const DEFAULT_STATE_FIELDS: readonly string[] = [
  IMPORT_FIELDS.outcome,
  IMPORT_FIELDS.lpr,
  IMPORT_FIELDS.status,
  IMPORT_FIELDS.niche,
  IMPORT_FIELDS.note,
];

export type LprValue = 'yes' | 'no';
export type TargetValue = 'target' | 'non_target';

/** Слот оператора для `ownerBy: row_ranges`: ярлык и диапазоны номеров строк (включительно). */
export interface OperatorSlot {
  /** Ярлык для сопоставления с учёткой, например «Оператор-01 (Синий)». */
  label: string;
  name: string;
  color: string;
  ranges: [number, number][];
}

export type OwnerBy =
  /** Владелец — в колонке с полем `operator`; значение сопоставляется с учёткой картой `ownerMap`. */
  | { kind: 'column' }
  /** Владелец — по диапазону номеров строк; карту «слот → учётка» утверждает РОП в предпросмотре. */
  | { kind: 'row_ranges'; slots: readonly OperatorSlot[] };

/** Маркер в заметке: подборка слов → код отметки для РОП (просьбы «не звонить», особые категории). */
export interface NoteMarker {
  code: string;
  /** Подстроки без учёта регистра. */
  words: readonly string[];
}

/** Профиль импорта: CONFIG 6.13 `import.profiles[]`. */
export interface ImportProfile {
  key: string;
  /** Заголовок колонки (регистр и пробелы не важны) → ключ поля. */
  columns: Readonly<Record<string, string>>;
  valueMaps: {
    /** Значение ячейки итога (без регистра, ё = е) → ключ итога из `calling.outcomes[]`. */
    outcome: Readonly<Record<string, string>>;
    lpr: Readonly<Record<string, LprValue>>;
    target: Readonly<Record<string, TargetValue>>;
  };
  ownerBy: OwnerBy;
  /** Ключи итогов от главного к второстепенному: при множественном выборе в ячейке берётся первый по списку. */
  outcomePriority: readonly string[];
  /** Ключ итога → вид (`no_answer`, `bad_number`, `callback`, `agreed`, `not_interested`, `not_target`, `do_not_call`). */
  outcomeKinds: Readonly<Record<string, string>>;
  /** Дата снимка таблицы, 'YYYY-MM-DD': дата последнего касания, раз в таблице нет даты звонка. */
  snapshotDate?: string;
  /** Сколько первых строк просматривать в поисках заголовков (по умолчанию 10). */
  headerScanRows?: number;
  /** Поля, входящие в ключ состояния (по умолчанию `DEFAULT_STATE_FIELDS`). */
  stateFields?: readonly string[];
  noteMarkers?: readonly NoteMarker[];
  /** Формы собственности с «личным» номером (ИП): 12 цифр — ИИН, хранится только HMAC. */
  personalIdForms?: readonly string[];
}

/** Нормализация для импорта; реализация — `createImportNormalizers` поверх `core/phone` и `core/names`. */
export interface ImportNormalizers {
  /** Название → без формы собственности, кавычек, регистра. */
  normalizeName(raw: string): string;
  /** ФИО → нормализованное. */
  normalizePerson(raw: string): string;
  /** Ячейка с номерами → номера (несколько в ячейке, заглушки остаются с `digits: null`). */
  splitPhones(cell: string): NormalizedPhone[];
  /** Форма собственности по колонке «Тип» и названию → нормализованный код (`тоо`, `ип`…) или пусто. */
  legalFormOf(typeCell: string, name: string): string;
  /** БИН/ИИН: ровно 12 цифр или `null`. */
  normalizeOrgId(raw: string): string | null;
}

/** Хэш для ключей строки и состояния (синхронный; сервер подставляет sha256). Не HMAC: ПДн наружу не уходят. */
export type KeyHashFn = (input: string) => string;

export type IssueSeverity = 'error' | 'review' | 'info';

export interface RowIssue {
  code: string;
  severity: IssueSeverity;
  detail?: string;
}

export interface ParsedAnswer {
  /** Исходный текст ячейки (для события импорта, PROCESS 3.7). */
  raw: string;
  /** Распознанные значения в порядке ячейки. */
  values: { raw: string; outcomeKey: string }[];
  /** Главный итог по приоритету профиля. */
  primary: string | null;
  /** Значения без карты: не угадываем, строка идёт «на разбор». */
  unknown: string[];
}

export interface ParsedRow {
  /** Номер строки в таблице (1-based). */
  rowNo: number;
  /** Сырые значения по ключам полей (подрезанные). */
  fields: Readonly<Record<string, string>>;
  legalForm: string;
  name: string;
  nameNorm: string;
  head: string;
  headNorm: string;
  region: string;
  orgId: string | null;
  /** Форма с «личным» номером: ИИН хранить только HMAC. */
  orgIdPersonal: boolean;
  phones: NormalizedPhone[];
  /** Рабочие номера (канон), без повторов. */
  workingPhones: string[];
  /** Цифры нерабочих номеров (заглушки). */
  stubPhones: string[];
  answer: ParsedAnswer;
  /** `''` — пусто (пусто ≠ «Нет»), `null` — значение не распознано. */
  lpr: LprValue | '' | null;
  target: TargetValue | '' | null;
  /** Ключ итога главного ответа и его вид. */
  outcomeKey: string | null;
  outcomeKind: string | null;
  /** Метка оператора из колонки (для `ownerBy: column`) или `null`. */
  operatorLabel: string | null;
  /** Отметки заметки: коды `noteMarkers`, `date_in_note`. */
  noteFlags: string[];
  /** D-048: профиль + хэш опознающих полей. */
  rowKey: string;
  /** D-048: хэш колонок итога, ЛПР, статуса, ниши, заметки. */
  stateKey: string;
  issues: RowIssue[];
}

export type ParseSheetResult =
  | { ok: true; headerRow: number; rows: ParsedRow[]; unmappedHeaders: string[]; skippedBlank: number }
  | { ok: false; error: 'header_not_found'; missing: string[] };
