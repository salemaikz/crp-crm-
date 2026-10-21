// Схема ConfigV1 (docs/CONFIG.md §6). Только типы, диапазоны и связи — значений по умолчанию нет:
// их даёт пресет `base`, поэтому все ключи обязательны (D-061). Объекты `.strict()`: неизвестный ключ —
// ошибка, а не тихое чтение чужой семантики (D-060). Связи между ключами — integrity.ts.
import { z } from 'zod';
import { OUTCOME_KINDS } from '../../calling/spec/types.js';
import { checkConfigSet } from '../integrity.js';
import {
  Archived,
  AssetKey,
  HexColor,
  HHMM,
  I18n,
  I18nLong,
  IsoWeekday,
  Key,
  keyedList,
  LocalDate,
  stepOf,
  TimeRange,
  TimeZone,
  uniqueArray,
} from './primitives.js';
import { RoleSchema } from '../../access/roles';
import { CAP_KINDS, FIELD_TYPES, GLOBAL_FIELD_OBJECTS, LOCALES, QUEUE_BUCKETS, SOURCE_KINDS, SPACE_FIELD_OBJECTS } from './constants.js';

const int = (min: number, max: number) => z.number().int().min(min).max(max);
const obj = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

// ---------------------------------------------------------------------------------------------
// global
// ---------------------------------------------------------------------------------------------

const LegalForm = obj({ key: Key, label: I18n, aliases: z.array(z.string().trim().min(1).max(100)), idIsPersonal: z.boolean(), archived: Archived });

const Org = obj({
  productName: I18n,
  timezone: TimeZone,
  locales: uniqueArray(z.enum(LOCALES), { min: 1 }),
  defaultLocale: z.enum(LOCALES),
  currency: z.literal('KZT'),
  legalForms: keyedList(LegalForm),
  idRule: z.enum(['kz_bin', 'none']),
  personIdRule: z.enum(['kz_iin_hmac', 'none']),
}).refine((o) => o.locales.includes(o.defaultLocale), { message: 'defaultLocale должен входить в locales', path: ['defaultLocale'] });

const Holiday = obj({ date: LocalDate, kind: z.enum(['holiday', 'workday']), note: z.string().max(200) });

const Calendar = obj({
  workdays: uniqueArray(IsoWeekday, { min: 1 }),
  workHours: TimeRange,
  callWindow: TimeRange,
  holidays: z.array(Holiday).refine((a) => new Set(a.map((h) => h.date)).size === a.length, 'даты праздников не должны повторяться'),
});

const Prefix = z.string().regex(/^\d{2,4}$/, 'префикс: 2–4 цифры');
const Phone = obj({
  country: z.literal('KZ'),
  mobilePrefixes: uniqueArray(Prefix),
  reviewPrefixes: uniqueArray(Prefix),
  landlinePrefixes: uniqueArray(Prefix),
});

const Dedup = obj({
  byOrgId: z.boolean(),
  byPhoneAndName: z.boolean(),
  pairs: obj({ sharedPhone: z.boolean(), nameAndHead: z.boolean() }),
});

const SourceRule = obj({ code: Key, type: z.enum(['legalFormIn', 'regionNotIn']), values: z.array(z.string().trim().min(1).max(200)).min(1) });
const Source = obj({
  key: Key,
  label: I18n,
  kind: z.enum(SOURCE_KINDS),
  allowPersonNames: z.boolean(),
  detailedReport: z.boolean(),
  rejectRules: z.array(SourceRule),
  holdRules: z.array(SourceRule),
  archived: Archived,
});

const Theme = obj({
  brandColor: HexColor,
  accentColor: HexColor,
  fontPreset: Key,
  radius: z.enum(['sm', 'md', 'lg']),
  density: z.enum(['compact', 'normal']),
  logo: AssetKey,
  statusStyle: z.enum(['color', 'color_text_icon']),
});

const Space = obj({ key: Key, label: I18n, enabled: z.boolean(), default: z.boolean() });

const Security = obj({
  sessionDays: int(1, 365),
  inviteTtlHours: int(1, 720),
  loginAttempts: obj({ perPhone: int(1, 50), perIp: int(1, 1000), windowMin: int(1, 1440) }),
  phoneProbesPerDay: int(0, 1000),
});

// --- Поля (CONFIG §6.11). Поля клиента и контакта — в global (клиент общий на установку, D-012),
// поля карточки, сделки и записи — в документе пространства (D-081).
const FieldOption = obj({ key: Key, label: I18n, archived: Archived });
const fieldOf = <O extends readonly [string, ...string[]]>(objects: O) =>
  obj({
    key: Key,
    object: z.enum(objects),
    type: z.enum(FIELD_TYPES),
    label: I18n,
    options: keyedList(FieldOption),
    /** Ключ — роль или `*`; значение — доступ. */
    access: z.record(z.string(), z.enum(['edit', 'read', 'hidden'])),
    required: obj({ always: z.boolean(), onOutcome: uniqueArray(Key), onStage: uniqueArray(Key) }),
    searchable: z.boolean(),
    filterable: z.boolean(),
    ingest: z.boolean(),
    pii: z.enum(['none', 'person', 'contact']),
    showOn: obj({ card: z.boolean(), kanban: z.boolean(), list: z.boolean() }),
    archived: Archived,
  });
export const GlobalField = fieldOf(GLOBAL_FIELD_OBJECTS);
export const SpaceField = fieldOf(SPACE_FIELD_OBJECTS);

export const GlobalConfigV1 = obj({
  org: Org,
  calendar: Calendar,
  phone: Phone,
  dedup: Dedup,
  sources: keyedList(Source),
  roles: keyedList(RoleSchema, { min: 1 }),
  team: obj({ fallbackOwnerRole: Key }),
  theme: Theme,
  spaces: keyedList(Space, { min: 1 }),
  security: Security,
  audit: obj({ retentionDays: int(30, 3650) }),
  fields: keyedList(GlobalField),
});
export type GlobalConfigV1 = z.infer<typeof GlobalConfigV1>;

// ---------------------------------------------------------------------------------------------
// пространство
// ---------------------------------------------------------------------------------------------

const Outcome = obj({
  key: Key,
  kind: z.enum(OUTCOME_KINDS),
  label: I18n,
  color: HexColor,
  order: int(0, 1000),
  reasonGroup: Key.nullable(),
  requires: obj({
    lpr: z.boolean(),
    reason: z.boolean(),
    callbackAt: z.boolean(),
    contact: z.boolean(),
    fields: uniqueArray(Key),
    agreement: z.boolean(),
  }),
  importAliases: z.array(z.string().trim().min(1).max(100)),
  archived: Archived,
});

const Reason = obj({ key: Key, label: I18n, needsText: z.boolean(), softness: z.enum(['soft', 'hard']), archived: Archived });

const Calling = obj({
  outcomes: keyedList(Outcome, { min: 1 }),
  lprRequiredOnContact: z.boolean(),
  lprNoRequiresInfo: z.boolean(),
  undoSeconds: int(0, 10),
  offlineWindowHours: int(1, 168),
  callbackPastToleranceMin: int(0, 60),
  callbackPresets: uniqueArray(stepOf('plus', 'nextWorkday', 'nextEvent')),
  retry: obj({ steps: z.array(stepOf('plus', 'nextWorkday')), maxAttempts: int(1, 10) }),
  returnDays: obj({ not_interested: int(1, 3650).nullable(), deal_lost_soft: int(1, 3650).nullable() }),
});

const Queue = obj({
  order: uniqueArray(z.enum(QUEUE_BUCKETS), { length: QUEUE_BUCKETS.length }),
  mobileFirst: z.boolean(),
  skipLimit: int(0, 50),
});

const Distribution = obj({
  mode: z.enum(['auto_even', 'top_up', 'manual', 'off']),
  schedule: obj({ from: HHMM, to: HHMM, everyMin: int(5, 1440), workdaysOnly: z.boolean() }).refine((s) => s.from < s.to, {
    message: 'from должен быть раньше to',
    path: ['to'],
  }),
  dailyCap: int(0, 500),
  capIncludes: uniqueArray(z.enum(CAP_KINDS)),
  capOverride: z.boolean(),
  topUpKeep: int(1, 500),
  participantRoles: uniqueArray(Key, { min: 1 }),
  inbound: obj({ rule: z.literal('channel_owner_then_least_loaded'), offHours: Key }),
});

const Intake = obj({
  demandWorkdays: int(1, 30),
  bufferDays: z.number().min(0).max(3),
  maxBatch: int(1, 1000),
});

const Stage = obj({
  key: Key,
  label: I18n,
  kind: z.enum(['open', 'won', 'lost']),
  order: int(0, 1000),
  requires: obj({
    fields: uniqueArray(Key),
    booking: z.boolean(),
    attendance: z.boolean(),
    nextTask: z.boolean(),
    amount: z.boolean(),
    serviceType: z.boolean(),
    reason: z.boolean(),
  }),
  staleDays: int(1, 365).nullable(),
  auto: z.enum(['on_agreed', 'on_attended']).nullable(),
  archived: Archived,
});
const Pipeline = obj({
  key: Key,
  kind: z.literal('sales'),
  label: I18n,
  createDealOn: z.enum(['agreed', 'client_created', 'manual']),
  stages: keyedList(Stage, { min: 2 }),
  archived: Archived,
});

const ServiceType = obj({ key: Key, label: I18n, routeToTeam: Key.nullable(), archived: Archived });
const Team = obj({ key: Key, label: I18n, archived: Archived });

const EventType = obj({
  key: Key,
  behavior: z.enum(['group', 'individual']),
  label: I18n,
  short: I18n,
  /** Мест на мероприятии; у `individual` — null. */
  capacity: int(1, 1000).nullable(),
  durationMin: int(5, 1440),
  /** Направления (`booking.directions[]`), к которым относится тип; пусто — все. */
  directions: uniqueArray(Key),
  archived: Archived,
});
const SeedSeries = obj({
  key: Key,
  eventTypeKey: Key,
  weekday: IsoWeekday,
  startTime: HHMM,
  durationMin: int(5, 1440),
  location: z.string().max(200),
  format: z.enum(['offline', 'online']),
  capacity: int(1, 1000),
});
const Booking = obj({
  eventTypes: keyedList(EventType),
  horizonDays: int(1, 365),
  groupOptions: int(1, 10),
  consultStripDays: int(1, 31),
  consult: obj({ slotMinutes: int(5, 480), hours: obj({ workdays: uniqueArray(IsoWeekday, { min: 1 }), start: HHMM, end: HHMM }) }),
  directions: keyedList(obj({ key: Key, label: I18n, archived: Archived })),
  grey: obj({ mode: z.enum(['assign', 'suggest']), schedule: obj({ first: HHMM, last: HHMM, stepMin: int(5, 240) }) }),
  duty: obj({ defaultRole: Key }),
  noShow: obj({ callbackAt: stepOf('plus', 'nextWorkday') }),
  attendance: obj({ autoNoShowWorkdays: int(1, 10).nullable(), sweepAt: HHMM.optional() }),
  nextStep: obj({ taskAt: stepOf('plus', 'nextWorkday') }),
  seedSeries: keyedList(SeedSeries),
});

const Reminders = obj({
  days: uniqueArray(z.enum(['today', 'tomorrow'])),
  templates: keyedList(obj({ key: Key, eventTypeKey: Key.nullable(), text: I18nLong })),
});

const TileParam = z.union([z.string().max(200), z.number(), z.boolean(), z.array(z.string().max(200))]);
const Reports = obj({
  callsPerHourTarget: int(1, 200).nullable(),
  tiles: keyedList(obj({ key: Key, label: I18n, kind: z.enum(['outcome_count', 'field_equals']), params: z.record(Key, TileParam) })),
  intakeTile: z.boolean(),
});

/** Номер строки таблицы (1 — первая строка файла). */
const RowNo = int(1, 1_000_000);

/**
 * Слот «диапазон строк → оператор» (D-191). Ярлык — нейтральный (цвет, номер блока), не ФИО: карту
 * «ярлык → учётка» утверждает РОП в предпросмотре. Слоты — настройка установки (CLI), не пресета.
 */
const OwnerSlot = obj({
  label: z.string().trim().min(1).max(60),
  ranges: z.array(z.tuple([RowNo, RowNo])).min(1).max(50),
});

/** Поле импорта (`head`, `activity`, `niche`…): ключ ядра импорта в camelCase или ключ `fields[]`. */
const ImportFieldKey = z.string().regex(/^[a-z][a-zA-Z0-9_]{0,39}$/, 'поле импорта: ^[a-z][a-zA-Z0-9_]{0,39}$');

const ImportProfile = obj({
  key: Key,
  label: I18n,
  /** Заголовок колонки файла → поле (системное или ключ `fields[]`). */
  columns: z.record(z.string().min(1).max(200), z.string().min(1).max(100)),
  valueMaps: obj({
    outcome: z.record(z.string().min(1).max(200), Key),
    lpr: z.record(z.string().min(1).max(200), z.boolean()),
    target: z.record(z.string().min(1).max(200), z.boolean()),
  }),
  ownerBy: z.enum(['column', 'row_ranges']),
  // Необязательные ключи D-191: отсутствие = пусто (как у `archived`), значения по умолчанию нет.
  /** Слоты для `ownerBy: row_ranges`; задаёт установка (`crmctl config set`), в пресете — пусто. */
  ownerSlots: z.array(OwnerSlot).max(100).optional(),
  /** Поле импорта → поле клиента (`global.fields`) или карточки (`fields[]` пространства). */
  fieldTargets: z.record(ImportFieldKey, obj({ object: z.enum(['client', 'card']), fieldKey: Key })).optional(),
  /** Слова в заметке → код отметки для РОП (просьбы «не звонить», особые категории). */
  noteMarkers: z.array(obj({ code: Key, words: z.array(z.string().trim().min(1).max(100)).min(1).max(50) })).max(20).optional(),
  outcomePriority: uniqueArray(Key),
  snapshotDate: LocalDate.nullable(),
  archived: Archived,
});

export const SpaceConfigV1 = obj({
  calling: Calling,
  /** Группа причин → причины. Группы — ключи, на них ссылаются итоги. */
  reasons: z.record(Key, keyedList(Reason)),
  queue: Queue,
  distribution: Distribution,
  intake: Intake,
  pipelines: keyedList(Pipeline, { min: 1 }),
  serviceTypes: keyedList(ServiceType),
  deals: obj({ purchaseFutureLimitHours: int(0, 720) }),
  teams: keyedList(Team),
  handoff: obj({ acceptSlaWorkdays: int(1, 30), alarmTo: uniqueArray(Key) }),
  booking: Booking,
  reminders: Reminders,
  fields: keyedList(SpaceField),
  tasks: obj({ overdueAlertMinutes: int(1, 1440), inboundReplyMinutes: int(1, 1440), askNextStep: z.record(Key, z.boolean()) }),
  reports: Reports,
  export: obj({ allowedRoles: uniqueArray(Key) }),
  notifications: obj({
    morningDigestAt: HHMM.nullable(),
    callbackSoonMinutes: int(1, 120).nullable(),
    quietHours: z.enum(['outside_work_hours', 'none']),
  }),
  alerts: obj({ intakeStaleHours: int(1, 720).nullable(), stockMinDays: z.number().min(0).max(60).nullable() }),
  timeline: obj({ crossSpace: z.enum(['none', 'summary', 'full']) }),
  import: obj({ profiles: keyedList(ImportProfile), maxFileMb: int(1, 50), maxRows: int(1, 100_000), rowsRetentionDays: int(1, 90) }),
});
export type SpaceConfigV1 = z.infer<typeof SpaceConfigV1>;

// ---------------------------------------------------------------------------------------------
// Набор: global + документы пространств по ключу пространства. Проверяется целиком: документы
// пространств ссылаются на роли и поля из global.
// ---------------------------------------------------------------------------------------------

export const ConfigSetV1 = obj({
  global: GlobalConfigV1,
  spaces: z.record(Key, SpaceConfigV1),
}).superRefine(checkConfigSet);
export type ConfigSetV1 = z.infer<typeof ConfigSetV1>;
