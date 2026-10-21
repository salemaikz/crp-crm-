// Сообщения о потере итогов другого сотрудника на общем телефоне (D-293 п. 2, D-308). ПДн удаляются с телефона сразу,
// не дожидаясь сервера; сообщение о потере (только id автора и opId, без ПДн) уходит сразу, а если не дошло (нет сети,
// 5xx, 429, сессия истекла) — ждёт в IndexedDB (meta) и уходит при следующей возможности: загрузка страницы с сессией
// или появление сети.
import { ensureDeviceId } from './device';
import type { OutboxStore } from './outboxStore';

/**
 * Итог сообщения: `sent` — журнал записан; `retry` — не дошло, повторить позже; `refused` — сервер отказал по существу
 * (400 — запрос неверен, 404 — такого сотрудника нет): повтор ничего не даст.
 */
export type ReportResult = 'sent' | 'retry' | 'refused';
export type ReportExpired = (authorId: string, opIds: string[]) => Promise<ReportResult>;

/** Сколько opId в одном сообщении (предел маршрута). */
export const EXPIRE_CHUNK = 100;
/** Ключ очереди в meta хранилища. */
const QUEUE_KEY = 'expiredReports';
/** Предел очереди: защита хранилища от бесконечного роста; на деле там единицы. Лишнее — самое старое — снимается. */
const QUEUE_MAX_IDS = 2_000;

export type PendingReport = { authorId: string; opIds: string[] };

const isPending = (x: unknown): x is PendingReport =>
  typeof x === 'object' && x !== null && typeof (x as PendingReport).authorId === 'string' && Array.isArray((x as PendingReport).opIds) && (x as PendingReport).opIds.every((id) => typeof id === 'string');

/** Очередь неотправленных сообщений о потере. Повреждённая запись — пустая очередь. */
export async function pendingExpiredReports(store: OutboxStore): Promise<PendingReport[]> {
  try {
    const raw = await store.getMeta(QUEUE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isPending) : [];
  } catch {
    return [];
  }
}

async function saveQueue(store: OutboxStore, queue: PendingReport[]): Promise<void> {
  let total = queue.reduce((n, r) => n + r.opIds.length, 0);
  while (total > QUEUE_MAX_IDS && queue.length > 0) {
    const head = queue[0]!;
    const cut = Math.min(head.opIds.length, total - QUEUE_MAX_IDS);
    head.opIds = head.opIds.slice(cut);
    total -= cut;
    if (head.opIds.length === 0) queue.shift();
  }
  await store.setMeta(QUEUE_KEY, JSON.stringify(queue));
}

/** Поставить сообщение в очередь: opId одного автора сводятся, повторы не задваиваются. */
export async function queueExpiredReport(store: OutboxStore, authorId: string, opIds: readonly string[]): Promise<void> {
  const queue = await pendingExpiredReports(store);
  const cur = queue.find((r) => r.authorId === authorId);
  if (cur) cur.opIds = [...new Set([...cur.opIds, ...opIds])];
  else queue.push({ authorId, opIds: [...new Set(opIds)] });
  await saveQueue(store, queue);
}

async function dropFromQueue(store: OutboxStore, authorId: string, opIds: readonly string[]): Promise<void> {
  const done = new Set(opIds);
  const queue = (await pendingExpiredReports(store))
    .map((r) => (r.authorId === authorId ? { ...r, opIds: r.opIds.filter((id) => !done.has(id)) } : r))
    .filter((r) => r.opIds.length > 0);
  await saveQueue(store, queue);
}

/**
 * Отправить очередь частями по EXPIRE_CHUNK. Отправленное и отклонённое по существу снимается; первое «не дошло» —
 * стоп до следующей возможности. true — очередь пуста. Ошибки хранилища не бросает.
 */
export async function flushExpiredReports(store: OutboxStore, report: ReportExpired): Promise<boolean> {
  try {
    for (const { authorId, opIds } of await pendingExpiredReports(store)) {
      for (let i = 0; i < opIds.length; i += EXPIRE_CHUNK) {
        const chunk = opIds.slice(i, i + EXPIRE_CHUNK);
        if ((await report(authorId, chunk).catch((): ReportResult => 'retry')) === 'retry') return false;
        await dropFromQueue(store, authorId, chunk);
      }
    }
    return (await pendingExpiredReports(store)).length === 0;
  } catch {
    return false;
  }
}

/** Сообщение о потере: POST /api/device/outbox-expired (запись журнала под сессией телефона). */
export function createExpiredReporter(store: OutboxStore, fetchImpl: typeof fetch = (...a) => fetch(...a)): ReportExpired {
  return async (authorId, opIds) => {
    try {
      const deviceId = await ensureDeviceId(store);
      const res = await fetchImpl('/api/device/outbox-expired', {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Device-Id': deviceId },
        body: JSON.stringify({ authorId, opIds }),
      });
      if (res.ok) return 'sent';
      return res.status === 400 || res.status === 404 ? 'refused' : 'retry';
    } catch {
      return 'retry';
    }
  };
}
