// Разбор таблицы записей на мероприятия (профиль «Записи», D-324, docs/import-bookings-design.md §4).
// Заголовки находятся по названиям, как у таблиц клиентов (`parse.ts`), но поля другие: клиент, вид, дата,
// время, оператор. ИИН «личных» форм в строку не попадает ни в каком виде, кроме HMAC (D-052): ключ
// `iin:<HMAC>` собирается сразу при разборе, сырых 12 цифр в `ParsedBookingRow` нет.

import { isValidDay } from '../time';
import { normalizeLabel } from './answer';
import { clipAuthorLabel } from './bookingMatch';
import { rowKeyOf, stateKeyOf } from './keys';
import type { PersonalIdHmac } from './personalId';
import { PERSONAL_ID_PREFIX } from './personalId';
import type { ImportNormalizers, KeyHashFn, RowIssue } from './types';

const SEP = '\u001f';

/** Поля профиля «Записи» (остальные колонки файла игнорируются). */
export const BOOKING_FIELDS = {
  name: 'name',
  legalForm: 'legalForm',
  phones: 'phones',
  orgId: 'orgId',
  eventType: 'eventType',
  eventDate: 'eventDate',
  eventTime: 'eventTime',
  operator: 'operator',
} as const;
const F = BOOKING_FIELDS;

/** Профиль, как его видит разбор: из `import.profiles[]` пространства (kind = bookings). */
export interface BookingProfile {
  key: string;
  /** Заголовок колонки (регистр и пробелы не важны) → поле. */
  columns: Readonly<Record<string, string>>;
  /** Значение ячейки вида (без регистра, ё = е) → ключ `booking.eventTypes[]`. */
  eventTypeMap: Readonly<Record<string, string>>;
  /** Вид, если колонки вида нет или ячейка пуста. */
  defaultEventTypeKey?: string;
  headerScanRows?: number;
  personalIdForms?: readonly string[];
}

export interface CompiledBookingProfile {
  profile: BookingProfile;
  columns: Map<string, string>;
  eventTypes: Map<string, string>;
}

export function compileBookingProfile(profile: BookingProfile): CompiledBookingProfile {
  return {
    profile,
    columns: new Map(Object.entries(profile.columns).map(([h, f]) => [normalizeLabel(h), f])),
    eventTypes: new Map(Object.entries(profile.eventTypeMap).map(([c, k]) => [normalizeLabel(c), k])),
  };
}

export interface ParsedBookingRow {
  rowNo: number;
  name: string;
  nameNorm: string;
  legalForm: string;
  /** БИН — 12 цифр; у «личной» формы — `iin:<HMAC>` (D-052). */
  orgId: string | null;
  orgIdPersonal: boolean;
  /** `orgIdPersonal` только по неуверенности (форма не определена): 12 цифр могут быть и БИН (D-141). */
  orgIdUncertain: boolean;
  /** Номера как в ячейке (для экрана РОП; живут в `import_rows` до чистки). */
  phonesRaw: string[];
  workingPhones: string[];
  stubPhones: string[];
  eventTypeKey: string | null;
  eventTypeRaw: string;
  /** 'YYYY-MM-DD' или null (тогда в `issues` есть `bad_date`). */
  eventDate: string | null;
  /** 'HH:MM' или null. */
  eventTime: string | null;
  authorLabel: string | null;
  /** Опознающие поля клиента + вид + дата + время, без автора (D-048). */
  rowKey: string;
  /** Автор (D-048): смена оператора в таблице меняет только его. */
  stateKey: string;
  issues: RowIssue[];
}

export type ParseBookingResult =
  | { ok: true; headerRow: number; rows: ParsedBookingRow[]; unmappedHeaders: string[]; skippedBlank: number }
  | { ok: false; error: 'header_not_found'; missing: string[] };

export interface ParseBookingDeps {
  normalizers: ImportNormalizers;
  hash: KeyHashFn;
  /** HMAC ИИН (D-052): у «личных» форм открытый ИИН в строку не попадает. */
  hmac: PersonalIdHmac;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Нулевые дни эпох Excel: XLSX-ячейка в формате времени без даты читается как `1899-12-30 ЧЧ:ММ` (или 1904-01-01). */
const EXCEL_EPOCH_DAYS: ReadonlySet<string> = new Set(['1899-12-30', '1904-01-01']);

/** `YYYY-MM-DD ЧЧ:ММ[:СС]` — так XLSX отдаёт ячейку с форматом даты и времени: дата и время отдельно. */
function splitDateTime(cell: string): { day: string; time: string } | null {
  const hit = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2}(?::\d{2})?)$/.exec((cell ?? '').trim());
  return hit ? { day: hit[1] as string, time: hit[2] as string } : null;
}

/**
 * Дата ячейки: `YYYY-MM-DD` (так отдаёт XLSX-ячейку с форматом даты), `YYYY-MM-DD ЧЧ:ММ` (дата со временем — берётся
 * дата), `ДД.ММ.ГГГГ`, `ДД.ММ.ГГ` (20ГГ), `ДД/ММ/ГГГГ`. Без года, текстом, несуществующая или нулевой день эпохи
 * Excel (это время без даты) — null: год не угадываем.
 */
export function parseEventDate(cell: string): string | null {
  const dt = splitDateTime(cell);
  if (dt && EXCEL_EPOCH_DAYS.has(dt.day)) return null;
  const s = dt ? dt.day : (cell ?? '').trim();
  let y: number;
  let m: number;
  let d: number;
  let hit = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (hit) [y, m, d] = [Number(hit[1]), Number(hit[2]), Number(hit[3])] as [number, number, number];
  else if ((hit = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(s))) [d, m, y] = [Number(hit[1]), Number(hit[2]), Number(hit[3])] as [number, number, number];
  else if ((hit = /^(\d{1,2})\.(\d{1,2})\.(\d{2})$/.exec(s))) [d, m, y] = [Number(hit[1]), Number(hit[2]), 2000 + Number(hit[3])] as [number, number, number];
  else return null;
  const day = `${y}-${pad(m)}-${pad(d)}`;
  return isValidDay(day) ? day : null;
}

/**
 * Время ячейки `Ч:ММ`/`ЧЧ:ММ` (секунды отбрасываются) → 'HH:MM'; null — не время. XLSX-ячейка в формате времени
 * приходит как `1899-12-30 ЧЧ:ММ` (полночь — просто `1899-12-30`), дата со временем — `YYYY-MM-DD ЧЧ:ММ`: берётся время.
 */
export function parseEventTime(cell: string): string | null {
  const raw = (cell ?? '').trim();
  if (EXCEL_EPOCH_DAYS.has(raw)) return '00:00';
  const hit = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(splitDateTime(raw)?.time ?? raw);
  if (!hit) return null;
  const h = Number(hit[1]);
  const m = Number(hit[2]);
  return h <= 23 && m <= 59 ? `${pad(h)}:${pad(m)}` : null;
}

/** Ключ строки: опознающие поля клиента (D-048) + БИН/HMAC + вид + дата + время; автора в нём нет. */
export function bookingRowKeyOf(
  profileKey: string,
  r: { nameNorm: string; workingPhones: readonly string[]; stubPhones: readonly string[]; legalForm: string; orgId: string | null; eventTypeKey: string | null; eventDate: string | null; eventTime: string | null },
  hash: KeyHashFn,
): string {
  const who = rowKeyOf(profileKey, { nameNorm: r.nameNorm, headNorm: '', workingPhones: r.workingPhones, stubPhones: r.stubPhones, legalForm: r.legalForm }, hash);
  return `${profileKey}:${hash([who, r.orgId ?? '', r.eventTypeKey ?? '', r.eventDate ?? '', r.eventTime ?? ''].join(SEP))}`;
}

/**
 * `bookings.import_key`: индекс `bookings_import_uq` общий на установку, а профили — объекты пространства,
 * поэтому в ключ входит пространство.
 */
export function bookingImportKey(spaceId: string, rowKey: string, hash: KeyHashFn): string {
  return `bk:${hash(`${spaceId}${SEP}${rowKey}`)}`;
}

/** Ключ состояния записи: только автор (регистр и пробелы не важны). */
export function bookingStateKeyOf(authorLabel: string | null, hash: KeyHashFn): string {
  return stateKeyOf({ operator: authorLabel ?? '' }, ['operator'], hash);
}

export function parseBookingSheet(grid: readonly (readonly string[])[], cp: CompiledBookingProfile, deps: ParseBookingDeps): ParseBookingResult {
  const scan = Math.min(grid.length, cp.profile.headerScanRows ?? 10);
  let headerIdx = -1;
  let colOf = new Map<string, number>();
  let unmapped: string[] = [];
  const hasKey = (cols: Map<string, number>) => cols.has(F.eventDate) && (cols.has(F.phones) || cols.has(F.orgId));
  for (let h = 0; h < scan; h++) {
    const cells = (grid[h] ?? []).map((c) => normalizeLabel(String(c ?? '')));
    const cols = new Map<string, number>();
    cells.forEach((label, i) => {
      const field = cp.columns.get(label);
      if (field && !cols.has(field)) cols.set(field, i);
    });
    if (hasKey(cols)) {
      headerIdx = h;
      colOf = cols;
      unmapped = cells.filter((c, i) => c && !cp.columns.has(c) && ![...cols.values()].includes(i));
      break;
    }
  }
  if (headerIdx < 0) {
    const known = new Set(cp.columns.values());
    const missing: string[] = [];
    if (!known.has(F.eventDate)) missing.push(F.eventDate);
    if (!known.has(F.phones) && !known.has(F.orgId)) missing.push(F.phones);
    // Профиль знает поля, а в файле заголовков нет: вызывающий подставит подписи колонок профиля
    return { ok: false, error: 'header_not_found', missing };
  }

  const personal = new Set(
    [
      ...deps.normalizers.personalFormCodes,
      ...(cp.profile.personalIdForms ?? []).map((x) => deps.normalizers.legalFormOf(x, '').code || x.trim().toLowerCase()),
    ].filter(Boolean),
  );
  const rows: ParsedBookingRow[] = [];
  let skippedBlank = 0;
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const raw = grid[i] ?? [];
    const cells: Record<string, string> = {};
    for (const [field, col] of colOf) cells[field] = String(raw[col] ?? '').trim();
    if (!cells[F.name] && !cells[F.phones] && !cells[F.orgId] && !cells[F.eventDate]) {
      skippedBlank++;
      continue;
    }
    rows.push(buildRow(i + 1, cells, cp, deps, personal));
  }
  return { ok: true, headerRow: headerIdx + 1, rows, unmappedHeaders: unmapped, skippedBlank };
}

function buildRow(rowNo: number, cells: Record<string, string>, cp: CompiledBookingProfile, { normalizers: n, hash, hmac }: ParseBookingDeps, personal: ReadonlySet<string>): ParsedBookingRow {
  const get = (f: string) => cells[f] ?? '';
  const issues: RowIssue[] = [];
  const name = get(F.name);
  const form = n.legalFormOf(get(F.legalForm), name);
  const legalForm = form.code;
  const phones = n.splitPhones(get(F.phones));
  const workingPhones = [...new Set(phones.flatMap((p) => (p.digits ? [p.digits] : [])))];
  const stubPhones = [...new Set(phones.flatMap((p) => (p.digits ? [] : [p.raw.replace(/\D+/g, '')])).filter(Boolean))];
  const nameNorm = n.normalizeName(name);

  // БИН/ИИН: «личный» (или форма не определена, D-141) хранится только как iin:<HMAC>
  const bin = n.normalizeOrgId(get(F.orgId));
  const personalForm = personal.has(legalForm);
  const orgIdPersonal = !!bin && personal.size > 0 && (personalForm || legalForm === '' || form.typeUnknown);
  const orgIdUncertain = orgIdPersonal && !personalForm;
  const orgId = bin ? (orgIdPersonal ? `${PERSONAL_ID_PREFIX}${hmac(bin)}` : bin) : null;
  if (get(F.orgId) && !bin) issues.push({ code: 'bad_org_id', severity: 'info' });

  // Вид: карта профиля, пустая ячейка — вид по умолчанию; непонятное значение не угадывается
  const eventTypeRaw = get(F.eventType);
  let eventTypeKey: string | null = null;
  if (eventTypeRaw) eventTypeKey = cp.eventTypes.get(normalizeLabel(eventTypeRaw)) ?? null;
  else eventTypeKey = cp.profile.defaultEventTypeKey ?? null;
  if (!eventTypeKey) issues.push({ code: 'unknown_event_type', severity: 'error', ...(eventTypeRaw ? { detail: eventTypeRaw } : {}) });

  const dateCell = get(F.eventDate);
  const eventDate = parseEventDate(dateCell);
  if (!eventDate) issues.push({ code: 'bad_date', severity: 'error' });
  // Колонки времени нет или ячейка пуста, а в ячейке даты есть время (`dd.mm.yyyy hh:mm` в XLSX) — время оттуда
  const timeCell = get(F.eventTime) || (eventDate ? (splitDateTime(dateCell)?.time ?? '') : '');
  const eventTime = timeCell ? parseEventTime(timeCell) : null;
  if (timeCell && !eventTime) issues.push({ code: 'bad_time', severity: 'error' });

  if (workingPhones.length === 0 && !orgId) issues.push({ code: 'no_client_key', severity: 'error' });
  if (phones.length > 1) issues.push({ code: 'many_phones', severity: 'info' });
  if (phones.some((p) => p.review)) issues.push({ code: 'phone_review', severity: 'info' });
  if (form.typeUnknown) issues.push({ code: 'unknown_legal_form', severity: 'review' });

  const authorLabel = clipAuthorLabel(get(F.operator)) || null;
  return {
    rowNo,
    name,
    nameNorm,
    legalForm,
    orgId,
    orgIdPersonal,
    orgIdUncertain,
    phonesRaw: phones.map((p) => p.raw),
    workingPhones,
    stubPhones,
    eventTypeKey,
    eventTypeRaw,
    eventDate,
    eventTime,
    authorLabel,
    rowKey: bookingRowKeyOf(cp.profile.key, { nameNorm, workingPhones, stubPhones, legalForm, orgId, eventTypeKey, eventDate, eventTime }, hash),
    stateKey: bookingStateKeyOf(authorLabel, hash),
    issues,
  };
}
