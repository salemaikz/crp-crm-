// Серии групповых мероприятий и их синхронизация (docs/booking-design.md §5.5, D-135). Синхронизация идёт
// сразу при правке серии РОП и заданием `events-ensure`; лишние нетронутые мероприятия «снимаются».
import { booking } from '@crm/core';
import { BadRequestError, ConflictError, type SystemActor, type Viewer } from '@/server/access';
import type { Sql } from '@/server/platform/db';
import { newId } from '@/server/platform/db';
import { BookingDomainError } from './errors';
import { requireRole, requireSpace } from './guards';
import {
  auditEvent,
  findSeries,
  insertEvent,
  insertSeries,
  listActiveSeriesIds,
  listSeriesRows,
  lockSeriesEvents,
  retireEvents,
  toSeriesLite,
  toSeriesView,
  updateOccurrence,
  updateSeriesRow,
  type SeriesRow,
} from './repo';
import { inBookingTx } from './tx';
import {
  EVENT_FORMATS,
  type BookingActor,
  type BookingDeps,
  type BookingSettings,
  type CreateSeries,
  type EnsureAllSeries,
  type ListSeries,
  type SeriesInput,
  type SyncReport,
  type SyncSeries,
  type UpdateSeries,
} from './types';

/** Поля серии: в границах таблицы и вид — групповой из настроек. */
function validateSeriesFields(settings: BookingSettings, s: SeriesInput): void {
  if (!settings.groupTypes.some((t) => t.key === s.eventTypeKey)) throw new BookingDomainError('invalid_settings');
  if (!Number.isInteger(s.weekday) || s.weekday < 1 || s.weekday > 7) throw new BadRequestError('weekday');
  if (!booking.isLocalTime(s.startTime)) throw new BadRequestError('start_time');
  if (!Number.isInteger(s.durationMin) || s.durationMin < 1 || s.durationMin > 1440) throw new BadRequestError('duration');
  if (!Number.isInteger(s.capacity) || s.capacity < 1 || s.capacity > 1000) throw new BadRequestError('capacity');
  if (s.location.length > 200) throw new BadRequestError('location');
  if (!(EVENT_FORMATS as readonly string[]).includes(s.format)) throw new BadRequestError('format');
}

function sameContent(row: SeriesRow, spaceId: string, s: SeriesInput): boolean {
  return (
    row.spaceId === spaceId &&
    row.eventTypeKey === s.eventTypeKey &&
    row.weekday === s.weekday &&
    row.startTime === s.startTime &&
    row.durationMin === s.durationMin &&
    row.location === s.location &&
    row.format === s.format &&
    row.capacity === s.capacity
  );
}

function occurrenceOptions(settings: BookingSettings, now: number): booking.OccurrenceOptions {
  return { tz: settings.timeZone, now, horizonDays: settings.horizonDays, isWorkday: (d) => settings.calendar.isWorkday(d) };
}

/**
 * Синхронизация одной серии в транзакции `tx`: серия `FOR UPDATE` (сериализует правку и job), мероприятия
 * горизонта `FOR UPDATE`, числа записей и дежурных — после блокировки; решение — `booking.planSeriesSync`.
 */
async function syncInTx(deps: BookingDeps, actor: BookingActor, tx: Sql, seriesId: string, now: number): Promise<SyncReport> {
  const series = await findSeries(tx, seriesId, true);
  if (!series || (actor.kind === 'user' && series.spaceId !== actor.spaceId)) throw new BookingDomainError('series_not_found');
  const settings = await deps.settings(series.spaceId, now);
  const today = booking.epochToLocalDate(settings.timeZone, now);
  const existing = await lockSeriesEvents(tx, seriesId, today);
  const plan = booking.planSeriesSync(toSeriesLite(series), existing, occurrenceOptions(settings, now));

  let created = 0;
  for (const occ of plan.create) {
    const inserted = await insertEvent(tx, {
      id: newId(),
      spaceId: series.spaceId,
      seriesId: series.id,
      eventTypeKey: series.eventTypeKey,
      eventDate: occ.eventDate,
      startTime: occ.startTime,
      startsAt: occ.startsAt,
      durationMin: occ.durationMin,
      location: occ.location,
      format: occ.format,
      capacity: occ.capacity,
      occurrenceKey: occ.occurrenceKey,
      at: now,
    });
    if (inserted) created++;
  }
  for (const u of plan.update) await updateOccurrence(tx, { id: u.id, changes: u.changes, at: now });
  await retireEvents(tx, plan.remove, now);
  return { seriesId, created, updated: plan.update.length, retired: plan.remove.length, skipped: plan.skipped };
}

export const syncSeries: SyncSeries = (deps, actor, seriesId, opts = {}) => inBookingTx(opts, (tx) => syncInTx(deps, actor, tx, seriesId, deps.now()));

/** Job `events-ensure`: все активные серии; каждая — в своей транзакции, сбой одной не останавливает остальные. */
export const ensureAllSeries: EnsureAllSeries = async (deps, actor: SystemActor) => {
  const ids = await inBookingTx({}, (tx) => listActiveSeriesIds(tx));
  const reports: SyncReport[] = [];
  let failed = 0;
  for (const id of ids) {
    try {
      reports.push(await syncSeries(deps, actor, id));
    } catch (e) {
      failed++;
      console.error('[booking] events-ensure: серия не синхронизирована', id, (e as { code?: unknown } | null)?.code ?? (e as Error | null)?.name ?? '');
    }
  }
  if (failed > 0) throw new Error(`events-ensure: не синхронизировано серий — ${failed} из ${ids.length}`);
  return reports;
};

export const listSeries: ListSeries = async (deps, viewer: Viewer) => {
  requireRole(viewer, 'booking.manage', 'section');
  const spaceId = requireSpace(viewer);
  const now = deps.now();
  const settings = await deps.settings(spaceId, now);
  const rows = await inBookingTx({}, (tx) => listSeriesRows(tx, spaceId));
  return rows.map((r) => toSeriesView(r, booking.seriesOccurrences(toSeriesLite(r), occurrenceOptions(settings, now)).skipped));
};

export const createSeries: CreateSeries = async (deps, viewer, input) => {
  requireRole(viewer, 'booking.manage', 'section');
  const spaceId = requireSpace(viewer);
  const now = deps.now();
  const { requestId, ...fields } = input;
  return inBookingTx({}, async (tx) => {
    const settings = await deps.settings(spaceId, now);
    validateSeriesFields(settings, fields);
    const inserted = await insertSeries(tx, { id: requestId, spaceId, ...fields, at: now });
    const row = await findSeries(tx, requestId, false);
    // Повтор ключа с другим содержимым или чужой серией — не «тот же запрос».
    if (!row || !sameContent(row, spaceId, fields)) throw new BookingDomainError('request_reused');
    if (inserted) await auditEvent(tx, { actor: viewer, action: 'series.create', entity: 'series', entityId: row.id, spaceId, meta: { eventTypeKey: row.eventTypeKey, weekday: row.weekday } });
    const sync = await syncInTx(deps, viewer, tx, row.id, now);
    const fresh = (await findSeries(tx, row.id, false)) ?? row;
    return { series: toSeriesView(fresh, sync.skipped), sync };
  });
};

export const updateSeries: UpdateSeries = async (deps, viewer, input) => {
  requireRole(viewer, 'booking.manage', 'section');
  const spaceId = requireSpace(viewer);
  const now = deps.now();
  return inBookingTx({}, async (tx) => {
    const cur = await findSeries(tx, input.seriesId, true);
    if (!cur || cur.spaceId !== spaceId) throw new BookingDomainError('series_not_found');
    if (cur.updatedAt !== input.seenUpdatedAt) throw new ConflictError();
    const settings = await deps.settings(spaceId, now);
    const p = input.patch;
    const next: SeriesInput = {
      eventTypeKey: p.eventTypeKey ?? cur.eventTypeKey,
      weekday: p.weekday ?? cur.weekday,
      startTime: p.startTime ?? cur.startTime,
      durationMin: p.durationMin ?? cur.durationMin,
      location: p.location ?? cur.location,
      format: p.format ?? (cur.format as SeriesInput['format']),
      capacity: p.capacity ?? cur.capacity,
    };
    // Формат старых данных может быть пустым: проверяем только то, что правят.
    validateSeriesFields(settings, { ...next, format: p.format ?? (cur.format === '' ? 'offline' : (cur.format as SeriesInput['format'])) });
    const updated = await updateSeriesRow(tx, {
      id: cur.id,
      ...next,
      active: p.active ?? cur.active,
      updatedAt: Math.max(now, cur.updatedAt + 1),
    });
    if (!updated) throw new BookingDomainError('series_not_found');
    await auditEvent(tx, { actor: viewer, action: 'series.update', entity: 'series', entityId: cur.id, spaceId, meta: { fields: Object.keys(p).sort(), active: updated.active } });
    const sync = await syncInTx(deps, viewer, tx, cur.id, now);
    return { series: toSeriesView(updated, sync.skipped), sync };
  });
};
