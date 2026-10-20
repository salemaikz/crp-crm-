// Контракт сессии между входом (P3) и ядром доступа (P4a). Дизайн: docs/auth-design.md §3, D-091, D-092.
// Cookie несёт непрозрачный токен (32 случайных байта, base64url); в sessions.id — его sha256 hex.
// Без JWT и без подписи: источник правды — строка в БД. До влития реализации P3 вызовы падают.
import { createHash, randomBytes } from 'node:crypto';
import * as React from 'react';
import { getDb, type Sql } from '../db';
import { writeAudit } from '../audit';
import { readSecurityPolicy } from './policy';
import type { IssuedSession, ResolvedSession, SecurityPolicy } from './types';

export type SessionInfo = {
  userId: string;
  sessionId: string;
  issuedAt: number; // epoch-мс
};

/** Форма токена в cookie: 43 знака base64url (256 бит). Иное — гость без запроса в БД. */
export const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** Как часто продлевать срок: не чаще раза в час на сессию (иначе запись в БД на каждый запрос). */
export const SESSION_TOUCH_INTERVAL_MS = 60 * 60_000;

/** Сколько живых сессий у сотрудника; при входе сверх предела удаляются давно не использованные. */
export const MAX_SESSIONS_PER_USER = 10;

const DAY_MS = 86_400_000;

async function loadSession(): Promise<SessionInfo | null> {
  // Динамически: next/headers нужен только в запросе Next, модуль остаётся загружаемым в unit-тестах
  const { readSessionToken } = await import('../http/sessionCookie');
  const token = await readSessionToken();
  if (!token || !SESSION_TOKEN_RE.test(token)) return null; // гость без запроса в БД
  const policy = await readSecurityPolicy();
  const db = await getDb();
  const now = Date.now();
  const r = await resolveSession(db.sql, token, policy, now);
  if (!r) return null;
  if (r.touched) await reissueCookie(r, token, now, (await import('../http/sessionCookie')).setSessionCookie);
  return { userId: r.userId, sessionId: r.sessionId, issuedAt: r.issuedAt };
}

/**
 * Срок сессии продлён в БД — переставляем cookie тем же токеном с новым Max-Age, иначе cookie
 * истечёт по первоначальному сроку (D-091). Это работает в route handler и server action; из
 * серверного компонента Next не даёт менять cookie — тогда ничего не делаем: срок в БД уже
 * продлён, cookie переставит первый же запрос обработчика. Сбой установки не роняет запрос.
 */
export async function reissueCookie(
  r: Pick<ResolvedSession, 'expiresAt'>,
  token: string,
  nowMs: number,
  set: (s: { token: string; maxAgeSec: number }) => Promise<void>,
): Promise<boolean> {
  try {
    await set({ token, maxAgeSec: Math.max(1, Math.floor((r.expiresAt - nowMs) / 1000)) });
    return true;
  } catch {
    return false;
  }
}

// cache() есть только в серверной сборке React (RSC / route handler); в unit-тестах — без кэша
const cached: () => Promise<SessionInfo | null> = typeof React.cache === 'function' ? React.cache(loadSession) : loadSession;

/**
 * Текущая сессия запроса или null (нет cookie, неверная форма, нет строки, истекла, сотрудник
 * отключён или без пароля). Читает cookie через platform/http/sessionCookie.ts, кэш на запрос.
 * Сбой БД — исключение, а не null: иначе отказ БД выглядел бы как выход из системы.
 */
export async function getSession(): Promise<SessionInfo | null> {
  return cached();
}

/** sha256 hex токена = sessions.id. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Создать сессию в транзакции вызывающего: удаляет истёкшие сессии сотрудника и лишние сверх
 * MAX_SESSIONS_PER_USER, пишет last_login_at и аудит `session.login`. Cookie ставит вызывающий.
 */
export async function createSession(
  sql: Sql,
  input: { userId: string; policy: SecurityPolicy; nowMs: number },
): Promise<IssuedSession> {
  const { userId, policy, nowMs } = input;
  const token = randomBytes(32).toString('base64url');
  const sessionId = hashSessionToken(token);
  const maxAgeSec = policy.sessionDays * 86_400;
  const expiresAt = nowMs + policy.sessionDays * DAY_MS;
  await sql`DELETE FROM sessions WHERE user_id = ${userId} AND expires_at <= ${nowMs}`;
  await sql`
    INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at)
    VALUES (${sessionId}, ${userId}, ${nowMs}, ${expiresAt}, ${nowMs})`;
  // сверх предела — давно не использованные (новую не трогаем даже при равных метках времени)
  await sql`
    DELETE FROM sessions WHERE id IN (
      SELECT id FROM sessions WHERE user_id = ${userId} AND id <> ${sessionId}
      ORDER BY last_seen_at DESC, created_at DESC, id OFFSET ${MAX_SESSIONS_PER_USER - 1})`;
  await sql`UPDATE users SET last_login_at = ${nowMs} WHERE id = ${userId}`;
  await writeAudit(sql, { actorId: userId, action: 'session.login', entity: 'session', entityId: userId, meta: {}, createdAt: nowMs });
  return { token, sessionId, expiresAt, maxAgeSec };
}

/**
 * Сессия по сырому токену. Действительна, если expires_at > now, last_seen_at + sessionDays > now
 * (уменьшение срока в настройках действует сразу), users.status = 'active', password_hash не NULL.
 * Прошло SESSION_TOUCH_INTERVAL_MS с last_seen_at — продлевает срок (touched = true).
 */
export async function resolveSession(
  sql: Sql,
  token: string | null | undefined,
  policy: SecurityPolicy,
  nowMs: number,
): Promise<ResolvedSession | null> {
  if (!token || !SESSION_TOKEN_RE.test(token)) return null;
  const sessionId = hashSessionToken(token);
  const [row] = await sql<{
    userId: string;
    createdAt: number;
    expiresAt: number;
    lastSeenAt: number;
    status: string;
    hasPassword: boolean;
  }>`
    SELECT s.user_id, s.created_at, s.expires_at, s.last_seen_at, u.status, (u.password_hash IS NOT NULL) AS has_password
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ${sessionId}`;
  if (!row) return null;
  if (row.expiresAt <= nowMs) return null;
  if (row.lastSeenAt + policy.sessionDays * DAY_MS <= nowMs) return null;
  if (row.status !== 'active' || !row.hasPassword) return null;
  let expiresAt = row.expiresAt;
  let touched = false;
  if (nowMs - row.lastSeenAt >= SESSION_TOUCH_INTERVAL_MS) {
    expiresAt = nowMs + policy.sessionDays * DAY_MS;
    await sql`UPDATE sessions SET last_seen_at = ${nowMs}, expires_at = ${expiresAt} WHERE id = ${sessionId}`;
    touched = true;
  }
  return { userId: row.userId, sessionId, issuedAt: row.createdAt, expiresAt, touched };
}

/** Удалить одну сессию по сырому токену (выход). Неверная форма или нет строки — ничего. */
export async function revokeSessionByToken(sql: Sql, token: string | null | undefined): Promise<void> {
  if (!token || !SESSION_TOKEN_RE.test(token)) return;
  await sql`DELETE FROM sessions WHERE id = ${hashSessionToken(token)}`;
}

/**
 * Удалить все сессии сотрудника, кроме `exceptSessionId` (если задан). Число удалённых — для аудита.
 * Вызывается в транзакции «выйти везде», смены и установки пароля и отключения сотрудника (D-066).
 */
export async function revokeAllSessions(
  sql: Sql,
  userId: string,
  opts: { exceptSessionId?: string } = {},
): Promise<number> {
  const rows = opts.exceptSessionId
    ? await sql`DELETE FROM sessions WHERE user_id = ${userId} AND id <> ${opts.exceptSessionId} RETURNING id`
    : await sql`DELETE FROM sessions WHERE user_id = ${userId} RETURNING id`;
  return rows.length;
}
