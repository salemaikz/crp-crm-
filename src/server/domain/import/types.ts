// Импорт таблиц: типы и сигнатуры сервиса (дизайн C4d — docs/import-design.md; D-048, D-111…D-116).
// Только типы: реализацию пишет builder (C4) в repo.ts (весь SQL), settings.ts, load.ts, preview.ts,
// apply.ts, rows.ts, purge.ts, service.ts. Сигнатуры не меняются без architect.
import type { dedup, imports } from '@crm/core';
import type { Viewer } from '@/server/access';
import type { CsvEncoding, SpreadsheetKind } from '@/server/platform/files/types';

/**
 * Кто действует. Это проекция Viewer из P4a (`@/server/access`): после влития P4a builder заменяет
 * тип на `Pick<Viewer, 'userId' | 'spaceId'>`. Охват импорта — пространство: строки imports читаются
 * только с `space_id = actor.spaceId`, чужое = 404 (D-017).
 */
export interface ImportActor {
  readonly userId: string;
  readonly spaceId: string;
  /**
   * Полный Viewer: профиль «Записи» (D-324) пишет записи и карточки от имени РОП и проверяет охваты
   * `booking.create` и `card.assign`. Нет Viewer — профиль «Записи» недоступен.
   */
  readonly viewer?: Viewer;
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

/** Ключи профиля «Записи» (D-324): карта видов мероприятий, вид по умолчанию, предел строк. */
export interface BookingProfileSetting {
  /** Значение ячейки (без регистра, ё = е) → ключ `booking.eventTypes[]`. */
  eventTypeMap: Readonly<Record<string, string>>;
  defaultEventTypeKey?: string;
  maxRows: number;
}

/** Предел строк профиля «Записи» по умолчанию (запись идёт через `createBooking` построчно). */
export const BOOKINGS_DEFAULT_MAX_ROWS = 2000;

/** `import.profiles[]` (CONFIG §6.13) после проверки Zod в settings.ts. */
export interface ImportProfileSetting extends imports.ImportProfile {
  label: string;
  kind: ImportProfileKind;
  /** Только у `kind = 'bookings'`. */
  bookings?: BookingProfileSetting;
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
  preview?: PreviewStamp | BookingsPreviewStamp;
  apply?: ApplyStamp | BookingsApplyStamp;
  /** Код ошибки, с которой импорт помечен failed. */
  error?: string;
}

export interface PreviewStamp {
  /** Нет `kind` — профиль клиентов (старые отчёты читаются без миграции). */
  kind?: 'clients';
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
  kind?: 'clients';
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
  | 'failed'
  /** Профиль «Записи»: ярлык автора строки без решения РОП. */
  | 'unmapped_authors'
  /** Профиль «Записи»: в настройках нет итога вида `agreed`. */
  | 'no_agreed_outcome'
  /** Профиль «Записи»: ни одной новой записи и ни одной смены автора. */
  | 'nothing_to_apply';

/** Карта авторов профиля «Записи»: ярлык → сотрудник пространства или null («автор неизвестен»). */
export type AuthorMapInput = Readonly<Record<string, string | null>>;

export interface PreviewRequest {
  ownerMap: OwnerMap;
  /** Только профиль «Записи». */
  authorMap?: AuthorMapInput;
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
  authorMap?: AuthorMapInput;
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
  | 'agreed_without_booking'
  // Профиль «Записи» (D-324): действия строки и группы отчёта (`group_<группа>`)
  | imports.BookingAction
  | `group_${imports.BookingGroup}`;

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
  /** Вид профиля загрузки: экран выбирает форму (карта владельцев или карта авторов). */
  kind: ImportProfileKind;
  /** Только профиль «Записи». */
  bookings?: BookingDetails;
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
  /** Профиль «Записи»: сотрудник карты авторов не из этого пространства. */
  | 'bad_author'
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

/**
 * Вход для маршрутов и страниц: делает то же, что `ImportService`, но по виду профиля загрузки — таблицы клиентов
 * или «Записи» (D-324). Вид берётся из профиля загрузки, а не из тела запроса.
 */
export interface ImportApi {
  listImports: ImportService['listImports'];
  getImport: ImportService['getImport'];
  upload: ImportService['upload'];
  preview(actor: ImportActor, importId: string, req: PreviewRequest, now: number): Promise<PreviewSummary | BookingPreviewSummary>;
  listRows(actor: ImportActor, importId: string, q: RowQuery, now: number): Promise<{ rows: (ImportRowView | BookingRowView)[]; total: number }>;
  /** `headers` — переведённые подписи колонок: у таблиц клиентов и у «Записей» они разные. */
  exportRowsCsv(
    actor: ImportActor,
    importId: string,
    filter: RowFilter,
    now: number,
    headers?: { clients?: readonly string[]; bookings?: readonly string[] },
  ): Promise<{ csv: string; rows: number }>;
  apply(actor: ImportActor, importId: string, req: ApplyRequest, now: number): Promise<ApplyResult | BookingApplyResult>;
}

/** Задача purge (воркер): строки старше import.rowsRetentionDays удаляются пачками по 5 000. */
export type PurgeImportRows = (system: ImportSystemActor, now: number) => Promise<{ deleted: number }>;

// ---------- Профиль «Записи» (D-324, docs/import-bookings-design.md §7, §8) ----------

/** Подсказка автора для ярлыка из таблицы: имена видит только РОП в ответе предпросмотра. */
export interface BookingAuthorHint {
  label: string;
  /** Сколько строк таблицы с этим ярлыком. */
  rows: number;
  by: 'phone' | 'name' | 'ambiguous' | 'none';
  suggestedUserId: string | null;
  suggestedName: string;
}

export interface BookingStaffItem {
  userId: string;
  name: string;
  /** Членство отключено: автор мог уволиться, заслуга остаётся (D-042). */
  disabled: boolean;
}

/** Данные экрана РОП для карты авторов: ярлыки с подсказками, решения последнего предпросмотра, кому можно приписать запись. */
export interface BookingDetails {
  hints: readonly BookingAuthorHint[];
  /** Карта из последнего предпросмотра по `authorMapRef`; null — «автор неизвестен». */
  savedAuthorMap: AuthorMapInput;
  staff: readonly BookingStaffItem[];
  /** Подписи видов мероприятий пространства: ключ → ru. */
  eventTypeLabels: Readonly<Record<string, string>>;
}

export interface BookingEventSummaryLine extends imports.BookingEventLine {
  typeLabel: string;
}

export interface BookingPreviewSummary {
  kind: 'bookings';
  importId: string;
  fingerprint: string;
  counts: imports.BookingPreviewCounts;
  /** «Будет записей по мероприятиям»: дата, вид, сколько и занято из мест. */
  byEvent: readonly BookingEventSummaryLine[];
  /** Карточки, которые перейдут в «Договорились». */
  willAgree: number;
  /** Задач «Уточнить договорённость», которые закроются самими переходами. */
  clarifyToClose: number;
  /** Открытых «Уточнить договорённость» в пространстве, которые останутся (РОП видит, что осталось без записи). */
  clarifyRemaining: number;
  hints: readonly BookingAuthorHint[];
  unmappedAuthors: readonly string[];
  blockers: readonly ApplyBlocker[];
}

/** `imports.report.preview` профиля «Записи»: отпечаток, ревизии, ссылки на авторов по хэшу ярлыка, счётчики. Без имён и номеров. */
export interface BookingsPreviewStamp {
  kind: 'bookings';
  fingerprint: string;
  at: number;
  by: string;
  buildId: string;
  configRev: ConfigRevPair;
  /** sha256(normalizeLabel(ярлык)) первые 16 hex → userId | null. */
  authorMapRef: Record<string, string | null>;
  counts: imports.BookingPreviewCounts;
}

export interface BookingApplyCounts {
  bookingsCreated: number;
  /** Карточки, переведённые в «Договорились» ядром. */
  cardsAgreed: number;
  /** Карточки без владельца, которые получили автора записи. */
  ownersAssigned: number;
  /** Строки, у которых сменился автор: записано только состояние, запись не менялась. */
  authorChanged: number;
  /** Закрытые переходами задачи «Уточнить договорённость». */
  clarifyClosed: number;
  /** Строки, которые остались РОП: дубли, конфликты, нет мероприятия и т. д. */
  skipped: number;
}

export interface BookingsApplyStamp {
  kind: 'bookings';
  at: number;
  by: string;
  fingerprint: string;
  durationMs: number;
  written: BookingApplyCounts;
}

export interface BookingApplyResult {
  kind: 'bookings';
  importId: string;
  alreadyApplied: boolean;
  appliedAt: number;
  written: BookingApplyCounts;
}

/** Строка предпросмотра профиля «Записи» для экрана РОП (ПДн видит только обладатель import.run). */
export interface BookingRowView {
  rowNo: number;
  name: string;
  phones: readonly string[];
  eventDate: string | null;
  eventTime: string | null;
  /** Ключ вида (`booking.eventTypes[]`) и значение ячейки как в файле. */
  eventTypeKey: string | null;
  eventTypeRaw: string;
  authorLabel: string | null;
  action: imports.BookingAction;
  groups: readonly imports.BookingGroup[];
  flags: readonly imports.BookingFlag[];
  clientId: string | null;
  eventId: string | null;
  bookingId: string | null;
  issues: readonly string[];
}
