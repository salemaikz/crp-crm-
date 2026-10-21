// Сообщения о потере итогов другого сотрудника на общем телефоне (D-293 п. 2, D-308). ПДн удаляются с телефона сразу,
// не дожидаясь сервера; сообщение о потере (только id автора и opId, без ПДн) уходит сразу, а если не дошло (нет сети,
// 5xx, 429, сессия истекла) — ждёт в IndexedDB (meta) и уходит при следующей возможности: загрузка страницы с сессией
// или появление сети. Следующим может войти сам автор: тогда сообщение уходит под его сессией (сервер принимает и
// свою потерю) и автор видит её на экране (D-309). Отказ сервера по существу не повторяется, но и не исчезает молча:
// след остаётся на телефоне в отдельной очереди. Та же очередь несёт и явное удаление своих итогов при выходе
// («Удалить их и выйти», причина `discarded`, D-311). Очередь меняется только атомарно (store.updateMeta).
import { ensureDeviceId } from './device';
import type { OutboxStore } from './outboxStore';

/**
 * Итог сообщения: `sent` — журнал записан; `retry` — не дошло, повторить позже; `refused` — сервер отказал по существу
 * (400 — запрос неверен, 404 — такого сотрудника нет): повтор ничего не даст, след остаётся в очереди отказов.
 */
export type ReportResult = 'sent' | 'retry' | 'refused';
export type ReportExpired = (authorId: string, opIds: string[], reason?: ExpiredReason) => Promise<ReportResult>;

/** Сколько opId в одном сообщении (предел маршрута). */
export const EXPIRE_CHUNK = 100;
/** Ключ очереди в meta хранилища. */
const QUEUE_KEY = 'expiredReports';
/** Ключ следа отказов (D-309): сервер отказал по существу, повтора нет, но запись о потере остаётся на телефоне. */
const REFUSED_KEY = 'expiredRefused';
/** Предел очереди: защита хранилища от бесконечного роста; на деле там единицы. Лишнее — самое старое — снимается. */
const QUEUE_MAX_IDS = 2_000;

/** Почему итоги удалены: по сроку (чужие на этом телефоне) или явным решением автора при выходе (D-311). */
export type ExpiredReason = 'expired' | 'discarded';
export type PendingReport = { authorId: string; opIds: string[]; reason?: ExpiredReason };

const isPending = (x: unknown): x is PendingReport =>
  typeof x === 'object' &&
  x !== null &&
  typeof (x as PendingReport).authorId === 'string' &&
  Array.isArray((x as PendingReport).opIds) &&
  (x as PendingReport).opIds.every((id) => typeof id === 'string') &&
  ((x as PendingReport).reason === undefined || (x as PendingReport).reason === 'expired' || (x as PendingReport).reason === 'discarded');

function parseQueue(raw: string | null): PendingReport[] {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isPending) : [];
  } catch {
    return [];
  }
}

async function readQueue(store: OutboxStore, key: string): Promise<PendingReport[]> {
  try {
    return parseQueue(await store.getMeta(key));
  } catch {
    return [];
  }
}

/** Очередь неотправленных сообщений о потере. Повреждённая запись — пустая очередь. */
export function pendingExpiredReports(store: OutboxStore): Promise<PendingReport[]> {
  return readQueue(store, QUEUE_KEY);
}

/** След сообщений, которые сервер отклонил по существу (D-309): только id, не отправляются повторно. */
export function refusedExpiredReports(store: OutboxStore): Promise<PendingReport[]> {
  return readQueue(store, REFUSED_KEY);
}

/** Предел очереди: лишнее — самое старое — снимается. */
function capQueue(queue: PendingReport[]): PendingReport[] {
  let total = queue.reduce((n, r) => n + r.opIds.length, 0);
  while (total > QUEUE_MAX_IDS && queue.length > 0) {
    const head = queue[0]!;
    const cut = Math.min(head.opIds.length, total - QUEUE_MAX_IDS);
    head.opIds = head.opIds.slice(cut);
    total -= cut;
    if (head.opIds.length === 0) queue.shift();
  }
  return queue;
}

/**
 * Изменить очередь атомарно (D-311): чтение, изменение и запись — одна транзакция хранилища. Уборка при загрузке,
 * отправка по событию online и вторая вкладка больше не затирают друг другу записи.
 */
function updateQueue(store: OutboxStore, key: string, change: (q: PendingReport[]) => PendingReport[]): Promise<unknown> {
  return store.updateMeta(key, (raw) => JSON.stringify(capQueue(change(parseQueue(raw)))));
}

const sameReport = (r: PendingReport, authorId: string, reason: ExpiredReason) => r.authorId === authorId && (r.reason ?? 'expired') === reason;

/** opId одного автора и одной причины сводятся, повторы не задваиваются. */
function merge(queue: PendingReport[], authorId: string, opIds: readonly string[], reason: ExpiredReason): PendingReport[] {
  const cur = queue.find((r) => sameReport(r, authorId, reason));
  if (cur) cur.opIds = [...new Set([...cur.opIds, ...opIds])];
  else queue.push(reason === 'expired' ? { authorId, opIds: [...new Set(opIds)] } : { authorId, opIds: [...new Set(opIds)], reason });
  return queue;
}

/** Поставить сообщение в очередь: opId одного автора сводятся, повторы не задваиваются. */
export async function queueExpiredReport(store: OutboxStore, authorId: string, opIds: readonly string[], reason: ExpiredReason = 'expired'): Promise<void> {
  await updateQueue(store, QUEUE_KEY, (q) => merge(q, authorId, opIds, reason));
}

/** Сервер отклонил сообщение по существу: повтора нет, но след потери остаётся на телефоне (D-309). */
export async function keepRefusedReport(store: OutboxStore, authorId: string, opIds: readonly string[], reason: ExpiredReason = 'expired'): Promise<void> {
  await updateQueue(store, REFUSED_KEY, (q) => merge(q, authorId, opIds, reason));
}

async function dropFromQueue(store: OutboxStore, authorId: string, opIds: readonly string[], reason: ExpiredReason): Promise<void> {
  const done = new Set(opIds);
  await updateQueue(store, QUEUE_KEY, (q) =>
    q.map((r) => (sameReport(r, authorId, reason) ? { ...r, opIds: r.opIds.filter((id) => !done.has(id)) } : r)).filter((r) => r.opIds.length > 0),
  );
}

export interface FlushOptions {
  /** Сотрудник, под чьей сессией уходит очередь: его собственные потери показываются ему на экране (D-309). */
  userId?: string;
  /** Сколько своих итогов сотрудника `userId` потеряно на этом телефоне и записано на сервере. Только при count > 0. */
  onOwnLost?: (count: number) => void;
}

/**
 * Отправить очередь частями по EXPIRE_CHUNK. Отправленное снимается; отклонённое по существу снимается из очереди, но
 * остаётся следом (keepRefusedReport); первое «не дошло» — стоп до следующей возможности. Очередь уходит под тем, кто
 * сейчас вошёл, в том числе если это сам автор: сервер принимает и свою потерю (D-309). true — очередь пуста. Ошибки
 * хранилища не бросает.
 */
export async function flushExpiredReports(store: OutboxStore, report: ReportExpired, opts: FlushOptions = {}): Promise<boolean> {
  let own = 0;
  try {
    for (const { authorId, opIds, reason = 'expired' } of await pendingExpiredReports(store)) {
      for (let i = 0; i < opIds.length; i += EXPIRE_CHUNK) {
        const chunk = opIds.slice(i, i + EXPIRE_CHUNK);
        const result = await report(authorId, chunk, reason).catch((): ReportResult => 'retry');
        if (result === 'retry') return false;
        if (result === 'refused') await keepRefusedReport(store, authorId, chunk, reason);
        // Тост «удалены по сроку» — только о потере по сроку: своё явное удаление автор подтвердил сам
        else if (authorId === opts.userId && reason === 'expired') own += chunk.length;
        await dropFromQueue(store, authorId, chunk, reason);
      }
    }
    return (await pendingExpiredReports(store)).length === 0;
  } catch {
    return false;
  } finally {
    if (own > 0) opts.onOwnLost?.(own);
  }
}

/** Сообщение о потере: POST /api/device/outbox-expired (запись журнала под сессией телефона; причина — D-311). */
export function createExpiredReporter(store: OutboxStore, fetchImpl: typeof fetch = (...a) => fetch(...a)): ReportExpired {
  return async (authorId, opIds, reason = 'expired') => {
    try {
      const deviceId = await ensureDeviceId(store);
      const res = await fetchImpl('/api/device/outbox-expired', {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Device-Id': deviceId },
        body: JSON.stringify(reason === 'expired' ? { authorId, opIds } : { authorId, opIds, reason }),
      });
      if (res.ok) return 'sent';
      return res.status === 400 || res.status === 404 ? 'refused' : 'retry';
    } catch {
      return 'retry';
    }
  };
}
