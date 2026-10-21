// Потеря неотправленных итогов на общем телефоне (D-293, D-308, D-309, D-311). Телефон удаляет итоги со свободным
// текстом — чужие по сроку или свои по явному решению оператора («Удалить их и выйти») — и сообщает об этом; сервер
// пишет журнал `user.outbox_expired`. Это мутация безопасности: её не блокируют ни лицензия, ни роль «только чтение»
// (маршрут помечен ключом ядра `device.outbox_expire`).
//
// Что журнал гарантирует, а что нет (D-311). Сервер не видит телефон: сообщение — заявление того, кто вошёл, и
// доказательством потери не является. Поэтому:
// - запись раздельно хранит `claimed` (заявлено телефоном: opId, причина, id устройства из заголовка и счётчик по
//   нему) и `checked` (проверено сервером при записи: автор существует, сколько уже дошло, сколько уже заявлено);
// - повтор не задваивает: opId, уже заявленные об этом авторе (кем угодно), второй раз не пишутся — сообщения об
//   одном авторе записываются по очереди;
// - статус потери выясняется позже, служебной проверкой по `calls` (verifyExpiredLosses): итог с этим opId дошёл —
//   заявление опровергнуто; не дошёл к сроку проверки — потеря подтверждена в той мере, в какой сервер может: итога
//   нет. Выдуманный opId тоже «не дойдёт» — это ограничено частотой и видно по `actorId`.
// Без ПДн: только id, числа, коды.
import type { SystemActor, Viewer } from '@/server/access';
import { NotFoundError } from '@/server/access';
import { writeAudit } from '@/server/platform/audit';
import { getDb } from '@/server/platform/db';
import { rateLimit } from '@/server/platform/ratelimit';
import { claimedExpiredOpIds, devicePendingOf, expiredClaimsSince, lockExpiredClaims, receivedCallIds, userExists } from './repo';

/**
 * Предел сообщений о потере за окно. Законный телефон шлёт по одному сообщению на автора (до 100 opId) при загрузке
 * страницы, и только пока в очереди есть неотправленное, — десятки в час не нужны. Общий предел сотрудника не даёт
 * обойти предел устройства, меняя `X-Device-Id`.
 */
export const EXPIRED_REPORT_LIMITS = { perDevice: 20, perUser: 60, windowMs: 3_600_000 } as const;

/**
 * Через сколько после записи потеря считается проверенной, если итог так и не дошёл (D-311). Телефон удаляет итог
 * старше срока офлайна и сообщает сразу; честно заявленный итог не дойдёт никогда. Итог, который ещё лежит на телефоне
 * автора (ложное заявление), обычно доходит со следующим входом автора — за смену или выходные. Опровержение
 * проверяется при каждом чтении, поэтому и позже срока дошедший итог переводит запись в «опровергнуто».
 */
export const EXPIRED_CHECK_AFTER_MS = 72 * 3_600_000;

/** Почему итоги удалены: по сроку на чужом телефоне или явным решением автора при выходе (D-311). */
export type ExpiredReason = 'expired' | 'discarded';
export type ExpiredReport = { authorId: string; opIds: readonly string[]; deviceId: string; reason?: ExpiredReason };
export type ExpiredResult = { ok: true } | { ok: false; retryAfterMs: number };

function limited(viewer: Viewer, deviceId: string, now: number): number | null {
  const { perDevice, perUser, windowMs } = EXPIRED_REPORT_LIMITS;
  const dev = rateLimit(`outbox-expired:dev:${viewer.userId}:${deviceId}`, perDevice, windowMs, now);
  if (!dev.ok) return dev.retryAfterMs;
  const user = rateLimit(`outbox-expired:user:${viewer.userId}`, perUser, windowMs, now);
  return user.ok ? null : user.retryAfterMs;
}

/**
 * Записать потерю итогов `authorId`. Автором может быть и сам `viewer` (D-309). Неизвестный автор → NotFoundError.
 * opId, уже записанные звонками или уже заявленные об этом авторе, отбрасываются; не осталось ничего — запись не
 * пишется. Ответ одинаковый (`ok`), сколько opId принято — клиент не узнаёт.
 */
export async function reportExpiredOutbox(viewer: Viewer, r: ExpiredReport, now: number): Promise<ExpiredResult> {
  const retryAfterMs = limited(viewer, r.deviceId, now);
  if (retryAfterMs !== null) return { ok: false, retryAfterMs };
  const db = await getDb();
  if (!(await userExists(db.sql, r.authorId))) throw new NotFoundError();
  const unique = [...new Set(r.opIds)];
  await db.tx(async (sql) => {
    // Ключ идемпотентности — (автор, opId): проверка и запись под одной блокировкой по автору
    await lockExpiredClaims(sql, r.authorId);
    const received = new Set(await receivedCallIds(sql, unique));
    const claimedBefore = new Set(await claimedExpiredOpIds(sql, r.authorId, unique));
    const lost = unique.filter((id) => !received.has(id) && !claimedBefore.has(id));
    if (lost.length === 0) return;
    await writeAudit(sql, {
      actorId: viewer.userId,
      action: 'user.outbox_expired',
      entity: 'user',
      entityId: r.authorId,
      spaceId: viewer.spaceId,
      createdAt: now,
      meta: {
        claimed: {
          count: lost.length,
          opIds: lost,
          reason: r.reason ?? 'expired',
          deviceId: r.deviceId,
          // Счётчик берётся по id устройства из заголовка телефона — это тоже заявление, а не проверка
          authorPendingOnDevice: r.deviceId === '' ? null : await devicePendingOf(sql, r.authorId, r.deviceId),
        },
        checked: { authorExists: true, alreadyReceived: received.size, alreadyClaimed: claimedBefore.size },
      },
    });
  });
  return { ok: true };
}

/** Итог проверки opId одной записи: дошёл (опровергнуто), не дошёл к сроку (подтверждено), срок не прошёл. */
export type LossVerdict = { delivered: string[]; notDelivered: string[]; unverified: string[] };

/** Чистая проверка одной записи журнала по множеству дошедших opId. */
export function lossVerdict(claimedAt: number, opIds: readonly string[], delivered: ReadonlySet<string>, now: number): LossVerdict {
  const out: LossVerdict = { delivered: [], notDelivered: [], unverified: [] };
  const due = now - claimedAt >= EXPIRED_CHECK_AFTER_MS;
  for (const id of opIds) {
    if (delivered.has(id)) out.delivered.push(id);
    else if (due) out.notDelivered.push(id);
    else out.unverified.push(id);
  }
  return out;
}

/**
 * Статус записи для РОП (D-311): `refuted` — заявленные итоги дошли (все); `partly_refuted` — часть дошла; `confirmed`
 * — к сроку не дошёл ни один; `claimed` — только заявление телефона, срок проверки не прошёл.
 */
export type LossStatus = 'claimed' | 'confirmed' | 'partly_refuted' | 'refuted';

export function lossStatus(v: LossVerdict): LossStatus {
  const total = v.delivered.length + v.notDelivered.length + v.unverified.length;
  if (total > 0 && v.delivered.length === total) return 'refuted';
  if (v.delivered.length > 0) return 'partly_refuted';
  if (v.unverified.length > 0) return 'claimed';
  return 'confirmed';
}

export type ExpiredLoss = {
  id: string;
  /** Кто заявил (сотрудник на телефоне). */
  actorId: string | null;
  /** Чьи итоги. */
  authorId: string;
  claimedAt: number;
  reason: ExpiredReason;
  claimedCount: number;
  status: LossStatus;
  verdict: LossVerdict;
};

const opIdsOf = (meta: Record<string, unknown>): string[] => {
  const ids = (meta.claimed as { opIds?: unknown } | undefined)?.opIds;
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
};

const reasonOf = (meta: Record<string, unknown>): ExpiredReason =>
  (meta.claimed as { reason?: unknown } | undefined)?.reason === 'discarded' ? 'discarded' : 'expired';

/**
 * Служебная проверка журнала потерь (D-311): каждая запись с `since` сверяется с `calls` на момент `now`. Журнал
 * только дополняется, поэтому вердикт не хранится, а считается при чтении — дошедший позже итог сразу опровергает
 * запись. Без ПДн: id и числа. Экран РОП (поток manager) показывает «заявлено телефоном» и итог проверки раздельно.
 */
export async function verifyExpiredLosses(_actor: SystemActor, q: { since: number }, now: number): Promise<ExpiredLoss[]> {
  const { sql } = await getDb();
  const rows = await expiredClaimsSince(sql, q.since);
  const all = [...new Set(rows.flatMap((r) => opIdsOf(r.meta)))];
  const delivered = new Set(await receivedCallIds(sql, all));
  return rows.map((r) => {
    const opIds = opIdsOf(r.meta);
    const verdict = lossVerdict(r.createdAt, opIds, delivered, now);
    return {
      id: r.id,
      actorId: r.actorId,
      authorId: r.authorId,
      claimedAt: r.createdAt,
      reason: reasonOf(r.meta),
      claimedCount: opIds.length,
      status: lossStatus(verdict),
      verdict,
    };
  });
}
