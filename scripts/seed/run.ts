// Синтетический сид стенда и e2e (PLAN O8b). Порядок: пресет через тот же путь, что `crmctl config apply` →
// сотрудники → серии мероприятий → клиенты, карточки, звонки, записи, сделки, задачи.
// Идемпотентность: id выводятся из зерна, вставки — ON CONFLICT DO NOTHING; повтор на тех же данных добавляет 0 строк.
// Только для стенда: при NODE_ENV=production нужны флаг и CRM_STAND=1, а база не должна содержать настоящих данных (assertStand, assertStandDb).
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fields, names, time } from '@crm/core';
import { runConfig, defaultCtx, type Io } from '../crmctl/config';
import { systemActor } from '../../src/server/access/systemActor';
import { bookingDeps, ensureAllSeries } from '../../src/server/domain/booking';
import { hashPassword, passwordProblem } from '../../src/server/platform/auth/password';
import { getActiveConfig, resetConfigCache } from '../../src/server/platform/config/active';
import { presetsRoot } from '../../src/server/platform/config/preset-files';
import { getDb, type Sql } from '../../src/server/platform/db';
import { phoneHmac } from '../../src/server/platform/hmac';
import { buildRows, type BuildCtx, type EventRef, type ResourceDef } from './build';
import { buildPlan } from './plan';
import { uuidFor } from './rng';
import { staffSpecs } from './staff';
import * as repo from './repo';

export const STAND_FLAG = '--i-know-this-is-a-stand';
export const DEFAULT_SEED = 'crm-stand-1';
export const PASSWORD_ENV = 'CRM_SEED_PASSWORD';
/** Положительный признак стенда в окружении: в production без него сид не стартует, даже с флагом. */
export const STAND_ENV = 'CRM_STAND';
/** Блок служебных номеров стенда (+7 709 …): всё, что вне него, считается настоящими данными. */
export const SYNTHETIC_PHONE_PREFIX = '7709';

/** Отказ запуска: production без явного подтверждения, неверные параметры, сбой применения пресета. */
export class SeedRefusedError extends Error {
  override name = 'SeedRefusedError';
}

export interface SeedOptions {
  seed?: string;
  clients?: number;
  operators?: number;
  spaceKey?: string;
  /** Слои пресета; по умолчанию base, kz, consulting-sales и накладка клиента из каталога пресетов. */
  layers?: string[];
  /** Явное подтверждение, что это стенд (обязательно при NODE_ENV=production). */
  standFlag?: boolean;
  env?: Record<string, string | undefined>;
  now?: number;
  io?: Io;
}

export interface Account {
  key: string;
  phone: string;
  name: string;
  role: string;
  /** Пароль печатается один раз — только у созданных в этом запуске и только если не задан через env. */
  password: string | null;
}

export interface SeedReport {
  config: 'applied' | 'unchanged';
  /** Добавлено строк по таблицам (0 — повторный запуск). */
  inserted: Record<string, number>;
  /** Всего изменений: добавленные строки + записанные ревизии настроек + назначенные руководители команд. */
  changes: number;
  accounts: Account[];
  /** Сколько создано мероприятий по сериям (events-ensure). */
  eventsCreated: number;
}

export function assertStand(env: Record<string, string | undefined>, flag: boolean): void {
  if (env.NODE_ENV !== 'production') return;
  if (!flag) throw new SeedRefusedError(`NODE_ENV=production: сид с синтетикой запрещён. Если это учебный стенд, добавьте ${STAND_FLAG} и задайте ${STAND_ENV}=1.`);
  if (env[STAND_ENV] !== '1') throw new SeedRefusedError(`NODE_ENV=production: одного ${STAND_FLAG} мало — в окружении стенда должно быть ${STAND_ENV}=1.`);
}

/**
 * Проверка самой базы (страховка от запуска на боевой установке): сид не пишет туда, где есть настоящие данные.
 * Отказ, если есть номера клиентов вне блока 7709, настройки менялись не пресетом (ui/cli/rollback/migration)
 * либо настройки уже применены, а в базе есть сотрудники с номерами вне блока 7709 (то есть применял не сид).
 */
export async function assertStandDb(sql: Sql): Promise<void> {
  const like = `${SYNTHETIC_PHONE_PREFIX}%`;
  const foreign = await sql<{ n: number }>`SELECT count(*)::int AS n FROM client_phones WHERE digits NOT LIKE ${like}`;
  if ((foreign[0]?.n ?? 0) > 0) throw new SeedRefusedError('В базе есть клиенты с номерами вне синтетического блока 7709: это не стенд, сид отказывает.');
  const manual = await sql<{ n: number }>`SELECT count(*)::int AS n FROM config_revisions WHERE source <> 'preset'`;
  if ((manual[0]?.n ?? 0) > 0) throw new SeedRefusedError('Настройки в базе менялись не пресетом (ui/cli/rollback/migration): это не стенд, сид отказывает.');
  const applied = await sql<{ n: number }>`SELECT count(*)::int AS n FROM config_revisions`;
  if ((applied[0]?.n ?? 0) > 0) {
    const real = await sql<{ n: number }>`SELECT count(*)::int AS n FROM users WHERE phone_digits NOT LIKE ${like}`;
    if ((real[0]?.n ?? 0) > 0) throw new SeedRefusedError('Настройки уже применены, а в базе есть сотрудники вне блока 7709: применял не сид, сид отказывает.');
  }
}

async function applyPreset(layers: string[], env: Record<string, string | undefined>): Promise<'applied' | 'unchanged'> {
  const out: string[] = [];
  const err: string[] = [];
  const base = defaultCtx();
  // Ассеты накладки нужны только для проверки логотипа и копирования; без тома — временный каталог стенда
  const assets = env.CRM_ASSETS_DIR?.trim() || path.join(process.env.TMPDIR ?? '/tmp', 'crm-stand-assets');
  const code = await runConfig(['apply', '--layers', layers.join(','), '--yes'], {
    ...base,
    io: { out: (l) => out.push(l), err: (l) => err.push(l) },
    openDb: async () => async () => {},
    env: { ...env, CRM_ASSETS_DIR: assets },
  });
  if (code !== 0) throw new SeedRefusedError(`Пресет не применён (код ${code}): ${[...err, ...out].join(' | ')}`);
  return out.some((l) => l.startsWith('записано ')) ? 'applied' : 'unchanged';
}

function genPassword(): string {
  return randomBytes(12).toString('base64url');
}

const sumInserted = (m: Record<string, number>): number => Object.values(m).reduce((a, b) => a + b, 0);

export async function runSeed(opts: SeedOptions = {}): Promise<SeedReport> {
  const env = opts.env ?? process.env;
  assertStand(env, opts.standFlag === true);
  const seed = opts.seed ?? DEFAULT_SEED;
  const nClients = opts.clients ?? 500;
  const nOperators = opts.operators ?? 5;
  if (!Number.isInteger(nClients) || nClients < 20 || nClients > 5000) throw new SeedRefusedError('--clients: целое от 20 до 5000');
  if (!Number.isInteger(nOperators) || nOperators < 1 || nOperators > 20) throw new SeedRefusedError('--operators: целое от 1 до 20');
  const now = opts.now ?? Date.now();
  const spaceKey = opts.spaceKey ?? 'sales';
  const envPassword = env[PASSWORD_ENV]?.trim() || null;
  const staff = staffSpecs(nOperators);
  if (envPassword) {
    for (const s of staff) if (passwordProblem(envPassword, s.phone)) throw new SeedRefusedError(`${PASSWORD_ENV}: пароль не проходит политику (${passwordProblem(envPassword, s.phone)})`);
  }

  await assertStandDb((await getDb()).sql);
  const layers = opts.layers ?? ['base', 'kz', 'consulting-sales', path.join(presetsRoot(env), 'clients', 'crp')];
  const configState = await applyPreset(layers, env);
  resetConfigCache();
  const cfg = await getActiveConfig();
  const space = cfg.spaces[spaceKey];
  if (!space) throw new SeedRefusedError(`В настройках нет пространства «${spaceKey}»`);
  const tz = cfg.global.org.timezone;
  const doc = space.doc;
  const db = await getDb();

  const inserted: Record<string, number> = {};
  const add = (table: string, n: number): void => {
    inserted[table] = (inserted[table] ?? 0) + n;
  };
  let extraChanges = configState === 'applied' ? 1 : 0;

  // --- серия мероприятий: пресет создаёт её сам; если нет — заводим свою; затем events-ensure на горизонт ---
  const groupType = doc.booking.eventTypes.find((t) => t.behavior === 'group');
  const individualType = doc.booking.eventTypes.find((t) => t.behavior === 'individual');
  if (!groupType || !individualType) throw new SeedRefusedError('В настройках нет группового и индивидуального видов записи');
  const hasSeries = (await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM event_series WHERE space_id = ${space.spaceId} AND event_type_key = ${groupType.key}`)[0]?.n ?? 0;
  if (hasSeries === 0) {
    add('event_series', await db.tx((sql) => repo.insertSeries(sql, { id: uuidFor(seed, 'series', groupType.key), spaceId: space.spaceId, eventTypeKey: groupType.key, weekday: 4, startTime: '15:00', durationMin: groupType.durationMin ?? 180, capacity: groupType.capacity ?? 30, at: now })));
  }
  const deps = { ...bookingDeps(), now: () => now };
  const sync = await ensureAllSeries(deps, systemActor('crmctl.seed', now));
  const eventsCreated = sync.reduce((a, r) => a + r.created, 0);
  add('events', eventsCreated);

  // --- пароли: хеш считается только для тех, кого ещё нет ---
  const phones = staff.map((s) => s.phone);
  const existing = new Set((await db.sql<{ phoneDigits: string }>`SELECT phone_digits FROM users WHERE phone_digits = ANY(${phones})`).map((r) => r.phoneDigits));
  const accounts: Account[] = [];
  const userRows: Record<string, unknown>[] = [];
  for (const s of staff) {
    if (existing.has(s.phone)) continue;
    const password = envPassword ?? genPassword();
    userRows.push({ id: uuidFor(seed, 'user', s.key), phone_digits: s.phone, name: s.name, password_hash: await hashPassword(password), is_admin: s.admin === true, created_at: now });
    accounts.push({ key: s.key, phone: s.phone, name: s.name, role: s.role ?? 'admin', password: envPassword ? null : password });
  }

  const plans = buildPlan({ seed, clients: nClients, operators: nOperators });
  await db.tx(async (sql) => {
    add('users', await repo.insertUsers(sql, userRows));
    const users = await userIds(sql, staff.map((s) => ({ key: s.key, phone: s.phone })));
    const teams = await teamIds(sql, space.spaceId);

    add(
      'memberships',
      await repo.insertMemberships(
        sql,
        staff.filter((s) => s.role !== null).map((s) => ({ user_id: users[s.key], space_id: space.spaceId, role_key: s.role, team_id: s.team ? (teams[s.team] ?? null) : null, in_distribution: s.distribution === true, created_at: now })),
      ),
    );
    for (const s of staff) if (s.team && teams[s.team]) extraChanges += await repo.setTeamLead(sql, teams[s.team] as string, users[s.key] as string);

    // консультанты: направления только из настроек
    const known = new Set(doc.booking.directions.map((d) => d.key));
    const pick = (list: string[]): string[] => list.filter((d) => known.has(d));
    const resources: ResourceDef[] = [
      { key: 'consultant1', userKey: 'consultant1', directions: pick(['consulting', 'program']), slotMin: 45 },
      { key: 'consultant2', userKey: 'consultant2', directions: pick(['marketing', 'automation', 'training']), slotMin: 45 },
    ].filter((r) => users[r.userKey] !== undefined);
    add('resources', await repo.insertResources(sql, resources.map((r, k) => ({ id: uuidFor(seed, 'resource', r.key), space_id: space.spaceId, user_id: users[r.userKey], directions: r.directions, slot_min: r.slotMin, sort: k, created_at: now }))));
    const sched: Record<string, unknown>[] = [];
    for (const r of resources) {
      for (let wd = 1; wd <= 5; wd++) {
        [['10:00', '13:00'], ['14:00', '18:00']].forEach(([from, to], w) => sched.push({ id: uuidFor(seed, 'sched', `${r.key}-${wd}-${w}`), resource_id: uuidFor(seed, 'resource', r.key), weekday: wd, start_time: from, end_time: to }));
      }
    }
    add('resource_schedule', await repo.insertSchedule(sql, sched));
    // у второго консультанта ближайшая пятница — выходной
    const today = time.localDayOf(now, tz);
    let friday = time.addLocalDays(today, 1);
    while (time.isoWeekday(friday) !== 5) friday = time.addLocalDays(friday, 1);
    const second = resources[1];
    if (second) add('resource_exceptions', await repo.insertExceptions(sql, [{ id: uuidFor(seed, 'exc', friday), resource_id: uuidFor(seed, 'resource', second.key), day: friday, created_at: now }]));

    // мероприятия: прошедшие четверги (для явки) и будущие из горизонта
    const series = (await sql<{ id: string; weekday: number; startTime: string; durationMin: number; capacity: number }>`
      SELECT id, weekday, start_time, duration_min, capacity FROM event_series
       WHERE space_id = ${space.spaceId} AND event_type_key = ${groupType.key} AND active ORDER BY created_at, id LIMIT 1`)[0];
    if (!series) throw new SeedRefusedError('Нет активной серии групповых мероприятий');
    const pastDays: string[] = [];
    for (let d = 1; d <= 28; d++) {
      const day = time.addLocalDays(today, -d);
      if (time.isoWeekday(day) === series.weekday) pastDays.push(day);
    }
    const keyOf = (day: string): string => `${series.id}:${day}`;
    add(
      'events',
      await repo.insertEvents(
        sql,
        pastDays.map((day) => ({ id: uuidFor(seed, 'event', keyOf(day)), space_id: space.spaceId, series_id: series.id, event_type_key: groupType.key, event_date: day, start_time: series.startTime, starts_at: time.fromLocalTime(day, series.startTime, tz), duration_min: series.durationMin, capacity: series.capacity, occurrence_key: keyOf(day), created_at: now })),
      ),
    );
    const evs = await sql<{ id: string; eventDate: string; startTime: string; startsAt: number; durationMin: number }>`
      SELECT id, event_date, start_time, starts_at, duration_min FROM events
       WHERE space_id = ${space.spaceId} AND series_id = ${series.id} AND status = 'scheduled' AND event_date >= ${pastDays[pastDays.length - 1] ?? today}
       ORDER BY starts_at`;
    const ref = (e: (typeof evs)[number]): EventRef => ({ id: e.id, date: e.eventDate, startTime: e.startTime, startsAt: e.startsAt, durationMin: e.durationMin });
    const pastEvents = evs.filter((e) => e.eventDate < today).map(ref).reverse();
    const futureEvents = evs.filter((e) => e.eventDate >= today).slice(0, 6).map(ref);

    const gDefs = [...cfg.global.doc.fields, ...doc.fields] as unknown as fields.FieldDef[];
    const roles = (cfg.global.doc.roles as unknown as Record<string, unknown>[]).map((r) => ({
      key: String(r.key),
      fieldAccessDefault: (['edit', 'read', 'hidden'].includes(String(r.fieldAccessDefault)) ? r.fieldAccessDefault : 'hidden') as fields.FieldAccess,
      archived: r.archived === true,
    }));
    const pipeline = doc.pipelines.find((p) => !p.archived && p.stages.some((s) => s.auto === 'on_agreed'));
    if (!pipeline) throw new SeedRefusedError('В настройках нет воронки с этапом on_agreed');
    const live = pipeline.stages.filter((s) => !s.archived);
    const reasons: Record<string, string[]> = {};
    for (const [k, list] of Object.entries(doc.reasons)) reasons[k] = list.filter((r) => !r.needsText && !r.archived).map((r) => r.key);

    const ctx: BuildCtx = {
      seed, tz, now, spaceId: space.spaceId, users,
      operatorKeys: staff.filter((s) => s.role === 'operator').map((s) => s.key),
      teams, configRev: cfg.rev, reasons, fieldDefs: gDefs,
      searchable: fields.searchableKeys(gDefs, roles),
      legalForms: names.legalFormsFromConfig(cfg.global.doc.org.legalForms),
      pipelineKey: pipeline.key,
      stageBooked: live.find((s) => s.auto === 'on_agreed')?.key as string,
      stageWon: live.find((s) => s.kind === 'won')?.key as string,
      serviceTypes: doc.serviceTypes.filter((t) => !t.archived).map((t) => ({ key: t.key, routeToTeam: t.routeToTeam })),
      directions: [...known],
      groupTypeKey: groupType.key, individualTypeKey: individualType.key,
      importProfile: doc.import.profiles[0]?.key ?? 'stand',
      seriesId: series.id, futureEvents, pastEvents, resources,
      phoneHmac: (d) => phoneHmac(d, env),
    };
    const rows = buildRows(plans, ctx);

    add('imports', await repo.insertImports(sql, rows.imports));
    add('clients', await repo.insertClients(sql, rows.clients));
    add('contacts', await repo.insertContacts(sql, rows.contacts));
    add('client_phones', await repo.insertPhones(sql, rows.phones));
    add('client_sources', await repo.insertClientSources(sql, rows.clientSources));
    add('cards', await repo.insertCards(sql, rows.cards));
    add('calls', await repo.insertCalls(sql, rows.calls));
    add('assign_log', await repo.insertAssignLog(sql, rows.assignLog));
    add('stop_list', await repo.insertStopList(sql, rows.stopList));
    add('notes', await repo.insertNotes(sql, rows.notes));
    add('client_events', await repo.insertClientEvents(sql, rows.clientEvents));
    add('deals', await repo.insertDeals(sql, rows.deals));
    add('bookings', await repo.insertBookings(sql, rows.bookings));
    add('booking_history', await repo.insertBookingHistory(sql, rows.bookingHistory));
    add('event_duty', await repo.insertDuty(sql, rows.duty));
    add('handoffs', await repo.insertHandoffs(sql, rows.handoffs));
    add('tasks', await repo.insertTasks(sql, rows.tasks));
  });

  return { config: configState, inserted, changes: sumInserted(inserted) + extraChanges, accounts, eventsCreated };
}

async function userIds(sql: Sql, list: { key: string; phone: string }[]): Promise<Record<string, string>> {
  const rows = await sql<{ id: string; phoneDigits: string }>`SELECT id, phone_digits FROM users WHERE phone_digits = ANY(${list.map((s) => s.phone)})`;
  const byPhone = new Map(rows.map((r) => [r.phoneDigits, r.id]));
  const out: Record<string, string> = {};
  for (const s of list) {
    const id = byPhone.get(s.phone);
    if (id) out[s.key] = id;
  }
  return out;
}

async function teamIds(sql: Sql, spaceId: string): Promise<Record<string, string>> {
  const rows = await sql<{ id: string; key: string }>`SELECT id, key FROM teams WHERE space_id = ${spaceId} AND archived_at IS NULL`;
  return Object.fromEntries(rows.map((r) => [r.key, r.id]));
}
