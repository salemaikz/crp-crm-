// Типы входа и сессий (P3). Дизайн: docs/auth-design.md, решения D-091…D-095.
// Только типы и константы: тела функций пишет builder по дизайну.

/** Политика из настроек `global.security` (CONFIG §6.16). При отсутствии настроек — значения по умолчанию. */
export type SecurityPolicy = {
  /** Скользящий срок сессии, дни (1…365). */
  sessionDays: number;
  /** Срок ссылки приглашения и сброса, часы (1…720). */
  inviteTtlHours: number;
  loginAttempts: {
    /** Неудач по номеру за окно, после которых включается нарастающая задержка. */
    perPhone: number;
    /** Неудач с одного IP за окно, после которых IP блокируется до конца окна. */
    perIp: number;
    windowMin: number;
  };
};

/** Значения по умолчанию CONFIG §6.16: ими же работает вход, если настройки ещё не применены. */
export const DEFAULT_SECURITY_POLICY: SecurityPolicy = Object.freeze({
  sessionDays: 30,
  inviteTtlHours: 72,
  loginAttempts: Object.freeze({ perPhone: 5, perIp: 20, windowMin: 15 }),
}) as SecurityPolicy;

/** Сессия, прочитанная из БД по cookie (расширяет SessionInfo контракта P4a). */
export type ResolvedSession = {
  userId: string;
  /** sha256 токена в hex = sessions.id. Не токен: по нему cookie не подделать. Клиенту не отдаётся. */
  sessionId: string;
  /** sessions.created_at, epoch-мс. */
  issuedAt: number;
  /** sessions.expires_at после касания, epoch-мс. */
  expiresAt: number;
  /** Срок продлён в этом запросе: route()/action() переставляют cookie (страница не может). */
  touched: boolean;
};

/** Новая сессия: сырой токен уходит только в cookie, в БД — его sha256. */
export type IssuedSession = { token: string; sessionId: string; expiresAt: number; maxAgeSec: number };

/** Параметры cookie сессии без Next: из них platform/http собирает Set-Cookie. */
export type SessionCookieSpec = {
  /** `__Host-crm_sid` при https, иначе `crm_sid` (локальная разработка, e2e на http://localhost). */
  name: string;
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: '/';
};

/** Ответ проверки частоты перед входом. */
export type ThrottleVerdict =
  | { ok: true }
  | { ok: false; reason: 'ip_blocked' | 'phone_delay'; retryAfterMs: number };

/** Итог попытки входа. Для «нет номера», «неверный пароль», «отключён», «нет пароля» — один `invalid`. */
export type LoginResult =
  | { ok: true; userId: string; session: IssuedSession; next: string }
  | { ok: false; error: 'validation' }
  | { ok: false; error: 'invalid'; retryAfterMs: number | null }
  | { ok: false; error: 'rate_limited'; retryAfterMs: number };

/** Проблема нового пароля; null — пароль годится. */
export type PasswordProblem = 'too_short' | 'too_long' | 'too_common' | 'same_as_phone';

export type InviteKind = 'invite' | 'reset';

/** Выданная ссылка: сырой токен показывается администратору один раз, в БД — только sha256. */
export type IssuedInvite = {
  inviteId: string;
  userId: string;
  token: string;
  /** `${APP_ORIGIN}/invite#${token}` — токен во фрагменте, на сервер и в логи не уходит. */
  link: string;
  expiresAt: number;
};

/** Что видит человек, открывший ссылку (до установки пароля). */
export type InvitePreview = { kind: InviteKind; name: string; phoneMasked: string };

export type InviteIssueError = 'exists' | 'disabled' | 'not_found' | 'self_role';
export type InviteAcceptError = 'invalid_token' | PasswordProblem;

/** Итог проверки Origin мутирующего запроса (CSRF, D-095). */
export type OriginVerdict = 'ok' | 'missing' | 'mismatch' | 'cross_site';
