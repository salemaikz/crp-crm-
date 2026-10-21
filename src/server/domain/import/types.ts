// Импорт таблиц: типы и сигнатуры сервиса (дизайн C4d — docs/import-design.md; D-048, D-111…D-116).
// Только типы: реализацию пишет builder (C4) в repo.ts (весь SQL), settings.ts, load.ts, preview.ts,
// apply.ts, rows.ts, purge.ts, service.ts. Сигнатуры не меняются без architect.
import type { dedup, imports } from '@crm/core';
import type { CsvEncoding, SpreadsheetKind } from '@/server/platform/files/types';

/**
 * Кто действует. Это проекция Viewer из P4a (`@/server/access`): после влития P4a builder заменяет
 * тип на `Pick<Viewer, 'userId' | 'spaceId'>`. Охват импорта — пространство: строки imports читаются
 * только с `space_id = actor.spaceId`, чужое = 404 (D-017).
 */
export interface ImportActor {
  readonly userId: string;
  readonly spaceId: string;
}

/** Системный исполнитель (задача purge): проекция SystemActor, только для src/server/jobs/**. */
export interface ImportSystemActor {
  readonly kind: 'system';
}

export type ImportStatus = 'preview' | 'applied' | 'failed';

/** Что загружает профиль. `bookings` — профиль «Записи» (C4b, PROCESS 12.39), в C4 не применяется. */
export type ImportProfileKind = 'clients' | 'bookings';

/** Куда пишется поле импорта сверх системных колонок клиента: ключ поля из `fields[]` (CONFIG §6.11). */
export interface FieldTarget {
  object: 'client' | 'card';
  fieldKey: string;
}

/** `import.profiles[]` (CONFIG §6.13) после проверки Zod в settings.ts. */
export interface ImportProfileSetting extends imports.ImportProfile {
  label: string;
  kind: ImportProfileKind;
  /** Поле импорта (head, activity, niche…) → поле клиента или карточки. Системные колонки не нужны. */
  fieldTargets: Readonly<Record<string, FieldTarget>>;
}

/** Раздел настроек импорта пространства + то, что импорт берёт из других разделов. */
export interface ImportSettings {
  profiles: readonly ImportProfileSetting[];
  maxFileMb: number;
  maxRows: number;
  rowsRetentionDays: number;
  /** Ключ источника `sources[]` вида import (`clients.source_key`, `client_sources.source_key`). */
  sourceKey: string;
  /** `sources[<sourceKey>].rejectRules` и `holdRules` (CONFIG §6.4). */
  rules: { reject: readonly dedup.SourceRule[]; hold: readonly dedup.SourceRule[] };
}

/** Ревизии настроек, на которых сделан разбор или предпросмотр (`config_revisions.rev`). */
export interface ConfigRevPair {
  global: number;
  space: number;
}

/** Ярлык слота (row_ranges) или значение колонки «оператор» (column) → id учётки. */
export type OwnerMap = Readonly<Record<string, string>>;

// ---------- imports.report (jsonb): только коды, id и числа — без имён, номеров и текста ячеек ----------

export interface ImportReportV1 {
  v: 1;
  input: {
    kind: SpreadsheetKind;
    encoding: CsvEncoding | null;
    bytes: number;
    sheetIndex: number;
    /** Дата снимка таблицы 'YYYY-MM-DD' (время импортного звонка: этот день 18:00 по поясу установки, не позже now). */
    snapshotDay: string;
    parseConfigRev: ConfigRevPair;
    /** Сборка, сделавшая разбор (CRM_BUILD_ID или 'dev'). */
    buildId: string;
  };
  parse: {
    headerRow: number;
    rows: number;
    skippedBlank: number;
    unmappedHeaders: number;
    truncatedCells: number;
    droppedColumns: number;
    formulaWithoutValue: number;
    errorCells: number;
    /** Код замечания строки → число строк. */
    issues: Record<string, number>;
  };
  preview?: PreviewStamp;
  apply?: ApplyStamp;
  /** Код ошибки, с которой импорт помечен failed. */
  error?: string;
}

export interface PreviewStamp {
  fingerprint: string;
  at: number;
  by: string;
  buildId: string;
  configRev: ConfigRevPair;
  /** sha256(normalizeLabel(ярлык)) первые 16 hex → userId: ярлыки бывают именами сотрудников. */
  ownerMapRef: Record<string, string>;
  counts: imports.PreviewCounts;
  perOperator: Record<string, number>;
  unowned: number;
  unmappedSlots: number;
  /** Задержанные или без владельца строки с рабочим итогом: встанут «новыми», итог — в ленте (D-115). */
  heldWithWorkingOutcome: number;
}

export interface ApplyCounts {
  clientsCreated: number;
  clientsMerged: number;
  cardsCreated: number;
  cardsUpdated: number;
  phonesAdded: number;
  callsCreated: number;
  pairsCreated: number;
  tasksCreated: number;
  stopListed: number;
  keptInCrm: number;
  skipped: number;
  /** userId → сколько карточек получил владельцем. */
  assigned: Record<string, number>;
}

export interface ApplyStamp {
  at: number;
  by: string;
  fingerprint: string;
  durationMs: number;
  written: ApplyCounts;
}

// ---------- Вход и выход сервиса ----------

export interface UploadInput {
  profileKey: string;
  /** Имя или номер листа (XLSX); для CSV не нужен. */
  sheet?: string | number;
  snapshotDay: string;
  /** Имя файла из заголовка X-File-Name: без управляющих символов, ≤ 120 символов. В лог и аудит не пишется. */
  fileName: string;
  body: Uint8Array;
}

export interface UploadResult {
  importId: string;
  kind: SpreadsheetKind;
  sheets: readonly string[];
  sheetIndex: number;
  headerRow: number;
  rows: number;
  skippedBlank: number;
  /** Заголовки без сопоставления (это подписи колонок, не данные клиентов). */
  unmappedHeaders: readonly string[];
  /** Этот файл (sha256) этим профилем уже применялся: предпросмотр покажет «без изменений». */
  sameFileApplied: { importId: string; appliedAt: number } | null;
}

export type ApplyBlocker =
  /** Ярлыки без учётки: РОП сопоставляет до «Применить». */
  | 'unmapped_slots'
  /** Профиль `row_ranges` без слотов в настройках установки: сначала слоты (D-191, D-222). */
  | 'no_owner_slots'
  /** Строки удалены по сроку import.rowsRetentionDays: загрузить файл заново. */
  | 'rows_expired'
  /** Настройки импорта, дедупа, источников или номеров изменились после разбора: загрузить заново. */
  | 'config_changed'
  | 'already_applied'
  | 'failed';

export interface PreviewRequest {
  ownerMap: OwnerMap;
}

export interface OperatorCount {
  userId: string;
  /** Имя сотрудника — для экрана РОП; в report не пишется. */
  name: string;
  count: number;
}

export interface PreviewSummary {
  importId: string;
  /** Отпечаток предпросмотра: передаётся в apply без изменений (D-113). */
  fingerprint: string;
  counts: imports.PreviewCounts;
  perOperator: readonly OperatorCount[];
  unowned: number;
  unmappedSlots: readonly string[];
  /** Пересечения диапазонов правил (row_ranges) — предупреждение до сопоставления. */
  ruleOverlaps: readonly { from: number; to: number; slots: string[] }[];
  heldWithWorkingOutcome: number;
  blockers: readonly ApplyBlocker[];
}

export interface ApplyRequest {
  fingerprint: string;
  ownerMap: OwnerMap;
}

export interface ApplyResult {
  importId: string;
  /** Повторный вызов по уже применённому импорту: ничего не записано, вернулся прежний итог. */
  alreadyApplied: boolean;
  appliedAt: number;
  written: ApplyCounts;
}

/** Фильтры списка строк предпросмотра и отчёта. */
export type RowFilter =
  | 'all'
  | 'create'
  | 'merge'
  | 'update_state'
  | 'kept_in_crm'
  | 'skip_same'
  | 'invalid'
  | 'duplicate_in_file'
  | 'stop_list'
  | 'rejected_rule'
  | 'held'
  | 'dup_pair'
  | 'import_conflict'
  | 'no_working_phone'
  | 'unowned'
  | 'need_review'
  | 'note_flag'
  | 'agreed_without_booking';

export interface RowQuery {
  filter: RowFilter;
  offset: number;
  /** ≤ 200. */
  limit: number;
}

/** Строка для экрана РОП (ПДн видит только обладатель import.run в своём пространстве). */
export interface ImportRowView {
  rowNo: number;
  name: string;
  phones: readonly string[];
  operatorLabel: string | null;
  outcomeKey: string | null;
  answerRaw: string;
  action: imports.RowAction;
  hold: imports.HoldReason | '';
  ownerUserId: string | null;
  issues: readonly string[];
  noteFlags: readonly string[];
  /** Клиент, с которым совпала строка (merge) или созданный применением. */
  clientId: string | null;
}

export interface ImportListItem {
  id: string;
  fileName: string;
  profileKey: string;
  status: ImportStatus;
  rows: number;
  createdAt: number;
  createdBy: string | null;
  appliedAt: number | null;
  /** Строки удалены по сроку: импорт только для просмотра счётчиков. */
  rowsExpired: boolean;
}

export interface ImportDetails extends ImportListItem {
  report: ImportReportV1;
  /** Ярлыки для карты владельцев: слоты профиля (row_ranges) или значения колонки «оператор». */
  ownerLabels: readonly string[];
  /** Карта из последнего предпросмотра, восстановленная по ownerMapRef. */
  savedOwnerMap: OwnerMap;
  /** Кому можно отдать строки: активные участники раздачи пространства. */
  candidates: readonly { userId: string; name: string }[];
}

/**
 * Ошибки сервиса → HTTP в маршруте: not_found 404 (и чужое пространство), feature_off 404,
 * busy 409, preview_stale 409 (+ свежая сводка), blocked 409 (+ blockers), rows_expired 410,
 * bad_owner 400, bad_profile 400, header_not_found 422, stand_unavailable 409 (тестовый стенд Vercel, D-318),
 * файл — коды SpreadsheetError (413/415/422/429).
 */
export type ImportErrorCode =
  | 'not_found'
  | 'feature_off'
  | 'busy'
  | 'preview_stale'
  | 'blocked'
  | 'rows_expired'
  | 'bad_owner'
  | 'bad_profile'
  | 'header_not_found'
  | 'stand_unavailable';

/** Сигнатуры сервиса импорта (service.ts). `now` — параметром, как в ядре. */
export interface ImportService {
  listImports(actor: ImportActor, limit: number): Promise<ImportListItem[]>;
  getImport(actor: ImportActor, importId: string, now: number): Promise<ImportDetails | null>;
  /** Разбор файла и запись imports + import_rows (status preview). Файл не сохраняется. */
  upload(actor: ImportActor, input: UploadInput, now: number): Promise<UploadResult>;
  /** Пересчёт предпросмотра по строкам и текущему состоянию БД; пишет report.preview. Бизнес-таблицы не меняет. */
  preview(actor: ImportActor, importId: string, req: PreviewRequest, now: number): Promise<PreviewSummary>;
  listRows(actor: ImportActor, importId: string, q: RowQuery, now: number): Promise<{ rows: ImportRowView[]; total: number }>;
  /** CSV строк по фильтру (формулы обезврежены); аудит import.export с кодом фильтра и числом строк. */
  exportRowsCsv(actor: ImportActor, importId: string, filter: RowFilter, now: number, headers?: readonly string[]): Promise<{ csv: string; rows: number }>;
  /** Применение строго по предпросмотру с тем же отпечатком (D-113). */
  apply(actor: ImportActor, importId: string, req: ApplyRequest, now: number): Promise<ApplyResult>;
}

/** Задача purge (воркер): строки старше import.rowsRetentionDays удаляются пачками по 5 000. */
export type PurgeImportRows = (system: ImportSystemActor, now: number) => Promise<{ deleted: number }>;
