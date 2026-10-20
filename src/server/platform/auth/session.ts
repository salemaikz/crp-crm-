// Контракт сессии между входом (P3) и ядром доступа (P4a). Дизайн: docs/auth-design.md §3, D-091, D-092.
// Cookie несёт непрозрачный токен (32 случайных байта, base64url); в sessions.id — его sha256 hex.
// Без JWT и без подписи: источник правды — строка в БД. До влития реализации P3 вызовы падают.
import type { Sql } from '../db';
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

/**
 * Текущая сессия запроса или null (нет cookie, неверная форма, нет строки, истекла, сотрудник
 * отключён или без пароля). Читает cookie через platform/http/sessionCookie.ts, кэш на запрос.
 * Сбой БД — исключение, а не null: иначе отказ БД выглядел бы как выход из системы.
 */
export async function getSession(): Promise<SessionInfo | null> {
  throw new Error('getSession: не реализовано (задача P3)');
}

/** sha256 hex токена = sessions.id. */
export function hashSessionToken(token: string): string {
  void token;
  throw new Error('hashSessionToken: P3');
}

/**
 * Создать сессию в транзакции вызывающего: удаляет истёкшие сессии сотрудника и лишние сверх
 * MAX_SESSIONS_PER_USER, пишет last_login_at и аудит `session.login`. Cookie ставит вызывающий.
 */
export async function createSession(
  sql: Sql,
  input: { userId: string; policy: SecurityPolicy; nowMs: number },
): Promise<IssuedSession> {
  void sql;
  void input;
  throw new Error('createSession: P3');
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
  void sql;
  void token;
  void policy;
  void nowMs;
  throw new Error('resolveSession: P3');
}

/** Удалить одну сессию по сырому токену (выход). Неверная форма или нет строки — ничего. */
export async function revokeSessionByToken(sql: Sql, token: string | null | undefined): Promise<void> {
  void sql;
  void token;
  throw new Error('revokeSessionByToken: P3');
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
  void sql;
  void userId;
  void opts;
  throw new Error('revokeAllSessions: P3');
}
