// Web-push (P8b, D-328): подписка устройства, отписка, переключатель администратора, наполнение очереди и отправка.
// Дизайн — docs/push-banner-design.md §2. Работает только при FEATURE_PUSH ∧ верных ключах VAPID ∧ отметке решения
// клиента ∧ включённом переключателе; иначе подписка не принимается, очередь не наполняется, стоящее отменяется.
// Push уходит только владельцу подписки и только пока жива сессия, которая подписала устройство (общий телефон).
import { createECDH } from 'node:crypto';
import { BadRequestError, UnauthorizedError, type SystemActor, type Viewer } from '@/server/access';
import { LOCKING_LICENSE_STATES } from '@/server/access/types';
import { writeAudit } from '@/server/platform/audit';
import { getDb, type Sql } from '@/server/platform/db';
import { isFeatureEnabled } from '@/server/platform/flags';
import type { QueueOutcome } from '@/server/platform/jobs/types';
import { isProduction } from '@/server/platform/env';
import { b64u, checkPushEndpoint, isUncompressedPoint, readVapidKeys, sendWebPush, type PushFetch, type VapidKeys, type VapidRead } from '@/server/platform/push';
import {
  disableDeadSubscriptions,
  disableOwnSubscriptions,
  insertOutbox,
  loadOutboxItem,
  markSubscriptionGone,
  markSubscriptionOk,
  pushCandidates,
  purgeDisabledSubscriptions,
  readPushSettings,
  savePushSettings,
  trimSubscriptions,
  upsertSubscription,
} from './pushRepo';
import { numericParams, PUSH_KINDS, pushTextFor, URGENT_PUSH_KINDS } from './pushText';

const MIN = 60_000;
/** Наполнение берёт уведомления не старше этого: пропущенное за простой воркера не догоняется. */
export const PUSH_FILL_WINDOW_MS = 30 * MIN;
/** Строка, ждавшая отправки дольше этого после своего `next_at`, отменяется как устаревшая. */
export const PUSH_MAX_DELAY_MS = 6 * 60 * MIN;
export const PUSH_FILL_LIMIT = 500;
export const PUSH_MAX_SUBSCRIPTIONS = 10;
export const PUSH_TTL_SEC = 12 * 3600;
/** Куда ведёт нажатие на push: колокол, подробности — после входа. */
export const PUSH_OPEN_URL = '/notifications';

export type PushOffReason = 'flag_off' | 'no_keys' | 'crossborder_not_approved' | 'disabled';

export interface PushDeps {
  flagOn: () => boolean;
  vapid: () => VapidRead;
  fetch: PushFetch;
}

let override: Partial<PushDeps> | null = null;

export function pushDeps(): PushDeps {
  return {
    flagOn: override?.flagOn ?? (() => isFeatureEnabled('PUSH')),
    vapid: override?.vapid ?? (() => readVapidKeys()),
    fetch: override?.fetch ?? ((url, init) => fetch(url, init)),
  };
}

/** Только тесты: подставить флаг, ключи и HTTP. В production — ошибка. */
export function overridePushDepsForTests(deps: Partial<PushDeps> | null): void {
  if (isProduction()) throw new Error('push: подмена зависимостей запрещена в production');
  override = deps;
}

type Gate = { usable: true; keys: VapidKeys } | { usable: false; reason: PushOffReason };

async function gate(sql: Sql, deps: PushDeps): Promise<Gate> {
  if (!deps.flagOn()) return { usable: false, reason: 'flag_off' };
  const v = deps.vapid();
  if (!v.ok) return { usable: false, reason: 'no_keys' };
  const s = await readPushSettings(sql);
  if (s.crossborderApprovedAt === null) return { usable: false, reason: 'crossborder_not_approved' };
  if (!s.enabled) return { usable: false, reason: 'disabled' };
  return { usable: true, keys: v.keys };
}

// ---------------------------------------------------------------------------
// Сотрудник: можно ли включить, подписка, отписка
// ---------------------------------------------------------------------------

/**
 * Для кнопки «Уведомления на телефон»: доступен ли push и ключ сервера для подписки. Причин не раскрываем. При лицензии
 * «только чтение» push не рассылается (очередь — деловая запись), поэтому и кнопки нет.
 */
export async function pushStatus(viewer: Viewer): Promise<{ available: boolean; publicKey: string | null }> {
  const deps = pushDeps();
  if (!deps.flagOn() || LOCKING_LICENSE_STATES.has(viewer.license)) return { available: false, publicKey: null };
  const g = await gate((await getDb()).sql, deps);
  return g.usable ? { available: true, publicKey: b64u.encode(g.keys.publicKey) } : { available: false, publicKey: null };
}

export interface SubscribeInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  deviceId: string;
}

const SESSION_ID_RE = /^[0-9a-f]{64}$/;
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{0,64}$/;

/** Ключ устройства: несжатая точка P-256 на кривой. */
function validP256dh(raw: string): boolean {
  const p = b64u.decode(raw);
  if (!isUncompressedPoint(p)) return false;
  try {
    const e = createECDH('prime256v1');
    e.generateKeys();
    e.computeSecret(p);
    return true;
  } catch {
    return false;
  }
}

/** Подписать это устройство на push сотрудника этой сессии. Адрес — только push-сервиса браузера (D-329). */
export async function subscribePush(viewer: Viewer, sessionId: string, input: SubscribeInput): Promise<{ ok: true }> {
  if (!SESSION_ID_RE.test(sessionId)) throw new UnauthorizedError();
  if (!checkPushEndpoint(input.endpoint)) throw new BadRequestError('push_endpoint');
  if (!validP256dh(input.p256dh) || b64u.decode(input.auth)?.length !== 16) throw new BadRequestError('push_keys');
  if (!DEVICE_ID_RE.test(input.deviceId)) throw new BadRequestError('push_device');
  const db = await getDb();
  const g = await gate(db.sql, pushDeps());
  if (!g.usable) throw new BadRequestError('push_off');
  await db.tx(async (sql) => {
    await upsertSubscription(sql, { userId: viewer.userId, sessionId, deviceId: input.deviceId, endpoint: input.endpoint, p256dh: input.p256dh, auth: input.auth, now: viewer.now });
    await trimSubscriptions(sql, { userId: viewer.userId, keep: PUSH_MAX_SUBSCRIPTIONS, now: viewer.now });
  });
  return { ok: true };
}

/**
 * Отписать: подписки этой сессии и (если задан) свою подписку с этим адресом. Работает и при выключенном push, и при
 * лицензии «только чтение» (часть выхода, мутация безопасности). Чужие подписки не трогаются.
 */
export async function unsubscribePush(viewer: Viewer, sessionId: string | null, endpoint: string | null): Promise<{ disabled: number }> {
  const sid = sessionId !== null && SESSION_ID_RE.test(sessionId) ? sessionId : null;
  const ep = endpoint !== null && checkPushEndpoint(endpoint) ? endpoint : null;
  if (sid === null && ep === null) return { disabled: 0 };
  const db = await getDb();
  const disabled = await db.tx((sql) => disableOwnSubscriptions(sql, { userId: viewer.userId, sessionId: sid, endpoint: ep, now: viewer.now }));
  return { disabled };
}

// ---------------------------------------------------------------------------
// Администратор: переключатель и отметка решения клиента
// ---------------------------------------------------------------------------

export interface PushAdminState {
  flagOn: boolean;
  keys: 'ok' | 'missing' | 'invalid';
  crossborderApprovedAt: number | null;
  enabled: boolean;
  usable: boolean;
  reason: PushOffReason | null;
  /** Лицензия «только чтение»: включённый push всё равно не рассылается, пока её не продлят. */
  pausedByLicense: boolean;
}

export async function pushAdminState(viewer: Viewer): Promise<PushAdminState> {
  const deps = pushDeps();
  const sql = (await getDb()).sql;
  const v = deps.vapid();
  const s = await readPushSettings(sql);
  const g = await gate(sql, deps);
  return {
    flagOn: deps.flagOn(),
    keys: v.ok ? 'ok' : v.code === 'missing' ? 'missing' : 'invalid',
    crossborderApprovedAt: s.crossborderApprovedAt,
    enabled: s.enabled,
    usable: g.usable,
    reason: g.usable ? null : g.reason,
    pausedByLicense: LOCKING_LICENSE_STATES.has(viewer.license),
  };
}

export interface PushSettingsInput {
  enabled: boolean;
  crossborderApproved: boolean;
  /** Дата письменного решения клиента 'YYYY-MM-DD' — обязательна, когда отметка ставится. В журнал, не в таблицу. */
  decisionDate: string | null;
}

/** Поставить или снять отметку решения и включить или выключить push. Снятие отметки выключает push. */
export async function setPushSettings(viewer: Viewer, input: PushSettingsInput): Promise<PushAdminState> {
  const deps = pushDeps();
  const db = await getDb();
  const enabled = input.enabled && input.crossborderApproved;
  if (enabled) {
    if (!deps.flagOn()) throw new BadRequestError('push_flag_off');
    if (!deps.vapid().ok) throw new BadRequestError('push_no_keys');
  }
  await db.tx(async (sql) => {
    const before = await readPushSettings(sql);
    const wasApproved = before.crossborderApprovedAt !== null;
    if (input.crossborderApproved && !wasApproved && (input.decisionDate === null || !/^\d{4}-\d{2}-\d{2}$/.test(input.decisionDate))) {
      throw new BadRequestError('push_decision_date');
    }
    const keepApproval = input.crossborderApproved && wasApproved;
    await savePushSettings(sql, {
      enabled,
      approvedAt: input.crossborderApproved ? viewer.now : null,
      approvedBy: input.crossborderApproved ? viewer.userId : null,
      keepApproval,
      by: viewer.userId,
      now: viewer.now,
    });
    await writeAudit(sql, {
      actorId: viewer.userId,
      action: 'push.settings',
      entity: 'push',
      entityId: 'push',
      meta: { enabled, approved: input.crossborderApproved, ...(input.crossborderApproved && !wasApproved ? { decisionDate: input.decisionDate } : {}) },
      createdAt: viewer.now,
    });
  });
  return pushAdminState(viewer);
}

/** Выключить push (мутация безопасности D-054: работает при любой лицензии). Отметка решения остаётся. */
export async function disablePush(viewer: Viewer): Promise<PushAdminState> {
  const db = await getDb();
  await db.tx(async (sql) => {
    await savePushSettings(sql, { enabled: false, approvedAt: null, approvedBy: null, keepApproval: true, by: viewer.userId, now: viewer.now });
    await writeAudit(sql, { actorId: viewer.userId, action: 'push.settings', entity: 'push', entityId: 'push', meta: { enabled: false }, createdAt: viewer.now });
  });
  return pushAdminState(viewer);
}

// ---------------------------------------------------------------------------
// Воркер: наполнение и отправка
// ---------------------------------------------------------------------------

/**
 * Шаг очереди перед взятием пачки: подписки умерших сессий выключаются; новые пары «уведомление × подписка» встают
 * в очередь с `next_at` по тихим часам. В payload — только вид и числа. Возвращает число новых строк.
 */
export async function fillPushOutbox(_actor: SystemActor, a: { now: number; nextAt: (at: number) => number }): Promise<number> {
  const db = await getDb();
  const g = await gate(db.sql, pushDeps());
  if (!g.usable) return 0;
  await disableDeadSubscriptions(db.sql, a.now);
  const found = await pushCandidates(db.sql, { kinds: PUSH_KINDS, since: a.now - PUSH_FILL_WINDOW_MS, now: a.now, limit: PUSH_FILL_LIMIT });
  if (found.length === 0) return 0;
  const nextAt = a.nextAt(a.now);
  const rows = found.map((c) => ({
    notificationId: c.notificationId,
    subscriptionId: c.subscriptionId,
    payload: JSON.stringify({ kind: c.kind, n: numericParams(c.params) }),
    nextAt,
  }));
  return insertOutbox(db.sql, { rows, now: a.now });
}

/** Обработчик строки очереди `push`: сверка, текст без ПДн, шифрование, отправка, итог кодом. */
export async function sendPushItem(_actor: SystemActor, id: string, now: number): Promise<QueueOutcome> {
  const db = await getDb();
  const deps = pushDeps();
  const row = await loadOutboxItem(db.sql, { id, now });
  if (!row || row.state !== 'pending') return { status: 'cancelled', error: 'gone_row' };
  const g = await gate(db.sql, deps);
  if (!g.usable) return { status: 'cancelled', error: 'push_off' };
  if (row.readAt !== null) return { status: 'cancelled', error: 'read' };
  if (!row.sameOwner || row.disabledAt !== null) return { status: 'cancelled', error: 'unsubscribed' };
  if (!row.sessionAlive) return { status: 'cancelled', error: 'session_gone' };
  if (now - row.nextAt > PUSH_MAX_DELAY_MS) return { status: 'cancelled', error: 'stale' };
  const kind = typeof row.payload.kind === 'string' ? row.payload.kind : '';
  const text = pushTextFor(kind, row.payload.n);
  const body = Buffer.from(JSON.stringify({ title: text.title, body: text.body, tag: kind, url: PUSH_OPEN_URL }));
  const p256dh = b64u.decode(row.p256dh);
  const auth = b64u.decode(row.auth);
  if (!p256dh || !auth) return { status: 'failed', error: 'bad_keys' };
  const res = await sendWebPush(
    { endpoint: row.endpoint, p256dh, auth, body, ttlSec: PUSH_TTL_SEC, urgency: URGENT_PUSH_KINDS.has(kind) ? 'high' : 'normal', topic: kind.replace(/_/g, '-').slice(0, 32) },
    g.keys,
    now,
    deps.fetch,
  );
  switch (res.kind) {
    case 'sent':
      await markSubscriptionOk(db.sql, { subscriptionId: row.subscriptionId, now });
      return { status: 'done' };
    case 'gone':
      await markSubscriptionGone(db.sql, { subscriptionId: row.subscriptionId, now });
      return { status: 'cancelled', error: 'gone' };
    case 'retry':
      return { status: 'retry', error: res.code };
    case 'rejected':
      return { status: 'failed', error: res.code };
  }
}

/** Чистка: выключенные подписки без строк очереди старше `before`. */
export async function purgePushSubscriptions(_actor: SystemActor, before: number): Promise<number> {
  return purgeDisabledSubscriptions((await getDb()).sql, before);
}
