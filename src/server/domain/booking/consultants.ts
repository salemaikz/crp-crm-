// Консультанты (B5a, без флага): список, создать, править, выключить. График и исключения — B5b.
// docs/deals-handoffs-design.md §4.2–4.4, D-245/D-246. Консультант не удаляется, а выключается: будущие записи
// остаются и видны РОП в «конфликтах». Доступ — `booking.manage`, охват — пространство зрителя.
import { BadRequestError, ConflictError, type Viewer } from '@/server/access';
import { writeAudit } from '@/server/platform/audit';
import { BookingDomainError } from './errors';
import { requireRole, requireSpace } from './guards';
import type { ConsultantInput, ConsultantPatch, ConsultantView, CreateConsultant, ListConsultants, UpdateConsultant } from './consultTypes';
import { activeMemberIds, actorUserId, findResourceByUser, findResourceListRow, insertResource, listResourceRows, listStaffWithoutResource, updateResourceRow, type ResourceListRow } from './repo';
import { inBookingTx } from './tx';
import type { BookingDeps, BookingSettings } from './types';

const SLOT_MIN = { min: 5, max: 480 };
const CAPACITY = { min: 1, max: 5 };
const SORT_MAX = 10_000;

const notFound = () => new BookingDomainError('consultant_not_found');

function toView(r: ResourceListRow): ConsultantView {
  return {
    id: r.id,
    userId: r.userId,
    name: r.name,
    directions: [...r.directions],
    slotMin: r.slotMin,
    capacity: r.capacity,
    autoAssign: r.autoAssign,
    active: r.active,
    sort: r.sort,
    usesSchedule: r.usesSchedule,
    updatedAt: r.updatedAt,
  };
}

/** Проверки значений: направления из `booking.directions`, слот 5–480, места 1–5. Ошибка — 400 с кодом поля. */
function checkValues(settings: BookingSettings, v: { directions: readonly string[]; slotMin: number; capacity: number; sort: number }): void {
  const known = new Set(settings.catalog.directions.map((d) => d.key));
  if (new Set(v.directions).size !== v.directions.length || v.directions.some((d) => !known.has(d))) throw new BadRequestError('direction');
  if (!Number.isInteger(v.slotMin) || v.slotMin < SLOT_MIN.min || v.slotMin > SLOT_MIN.max) throw new BadRequestError('slot_min');
  if (!Number.isInteger(v.capacity) || v.capacity < CAPACITY.min || v.capacity > CAPACITY.max) throw new BadRequestError('capacity');
  if (!Number.isInteger(v.sort) || v.sort < 0 || v.sort > SORT_MAX) throw new BadRequestError('sort');
}

export const listConsultants: ListConsultants = async (_deps, viewer, opts) => {
  requireRole(viewer, 'booking.manage', 'section');
  const spaceId = requireSpace(viewer);
  const rows = await inBookingTx({}, (tx) => listResourceRows(tx, { spaceId, includeInactive: opts.includeInactive }));
  return rows.map(toView);
};

/** Один консультант (карточка); чужого пространства и несуществующего нет. */
export async function getConsultant(_deps: BookingDeps, viewer: Viewer, resourceId: string): Promise<ConsultantView> {
  requireRole(viewer, 'booking.manage', 'section');
  const spaceId = requireSpace(viewer);
  const row = await inBookingTx({}, (tx) => findResourceListRow(tx, { id: resourceId, spaceId, lock: false }));
  if (!row) throw notFound();
  return toView(row);
}

/**
 * Создать консультанта. `requestId` — id ресурса: повтор того же запроса отдаёт созданного; сотрудник, который уже
 * консультант под другим ключом, — `consultant_exists`.
 */
export const createConsultant: CreateConsultant = async (deps, viewer, input: ConsultantInput) => {
  requireRole(viewer, 'booking.manage', 'section');
  const spaceId = requireSpace(viewer);
  const now = deps.now();
  const settings = await deps.settings(spaceId, now);
  checkValues(settings, input);
  return inBookingTx({}, async (tx) => {
    const existing = await findResourceByUser(tx, { spaceId, userId: input.userId });
    if (existing) {
      if (existing.id !== input.requestId) throw new BookingDomainError('consultant_exists');
      const again = await findResourceListRow(tx, { id: existing.id, spaceId, lock: false });
      if (!again) throw notFound();
      return toView(again);
    }
    // Тот же ключ, но другой сотрудник или пространство: ключ уже занят
    const clash = await findResourceListRow(tx, { id: input.requestId, spaceId, lock: false });
    if (clash) throw new BookingDomainError('request_reused');
    if ((await activeMemberIds(tx, spaceId, [input.userId])).length !== 1) throw new BadRequestError('consultant_user');
    const inserted = await insertResource(tx, {
      id: input.requestId,
      spaceId,
      userId: input.userId,
      directions: input.directions,
      slotMin: input.slotMin,
      capacity: input.capacity,
      autoAssign: input.autoAssign,
      sort: input.sort,
      at: now,
    });
    // Параллельный дубль по сотруднику или ключу: уникальный индекс не пустил вторую строку
    if (!inserted) throw new BookingDomainError('consultant_exists');
    await writeAudit(tx, {
      actorId: actorUserId(viewer),
      action: 'consultant.create',
      entity: 'resource',
      entityId: input.requestId,
      spaceId,
      meta: { userId: input.userId, slotMin: input.slotMin, capacity: input.capacity },
    });
    const row = await findResourceListRow(tx, { id: input.requestId, spaceId, lock: false });
    if (!row) throw notFound();
    return toView(row);
  });
};

export const updateConsultant: UpdateConsultant = async (deps, viewer, input) => {
  requireRole(viewer, 'booking.manage', 'section');
  const spaceId = requireSpace(viewer);
  const now = deps.now();
  const settings = await deps.settings(spaceId, now);
  const p: ConsultantPatch = input.patch;
  return inBookingTx({}, async (tx) => {
    const cur = await findResourceListRow(tx, { id: input.resourceId, spaceId, lock: true });
    if (!cur) throw notFound();
    if (cur.updatedAt !== input.seenUpdatedAt) throw new ConflictError();
    const next = {
      directions: p.directions ?? cur.directions,
      slotMin: p.slotMin ?? cur.slotMin,
      capacity: p.capacity ?? cur.capacity,
      autoAssign: p.autoAssign ?? cur.autoAssign,
      active: p.active ?? cur.active,
      sort: p.sort ?? cur.sort,
    };
    checkValues(settings, next);
    const ok = await updateResourceRow(tx, { id: cur.id, seenUpdatedAt: input.seenUpdatedAt, ...next, updatedAt: Math.max(now, cur.updatedAt + 1) });
    if (!ok) throw new ConflictError();
    await writeAudit(tx, {
      actorId: actorUserId(viewer),
      action: 'consultant.update',
      entity: 'resource',
      entityId: cur.id,
      spaceId,
      meta: { fields: Object.keys(p).sort() },
    });
    const row = await findResourceListRow(tx, { id: cur.id, spaceId, lock: false });
    if (!row) throw notFound();
    return toView(row);
  });
};

/** Сотрудники, которых можно сделать консультантами: активные члены пространства без ресурса. */
export async function listConsultantCandidates(_deps: BookingDeps, viewer: Viewer): Promise<{ userId: string; name: string }[]> {
  requireRole(viewer, 'booking.manage', 'section');
  const spaceId = requireSpace(viewer);
  return inBookingTx({}, (tx) => listStaffWithoutResource(tx, spaceId));
}
