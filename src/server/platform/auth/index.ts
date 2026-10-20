// Вход и сессии (P3): cookie + bcryptjs, без JWT. Дизайн: docs/auth-design.md, D-091…D-095.
// Cookie через Next ставит src/server/platform/http/sessionCookie.ts; здесь — логика без Next.
export * from './types';
export {
  getSession,
  createSession,
  resolveSession,
  revokeSessionByToken,
  revokeAllSessions,
  hashSessionToken,
  SESSION_TOKEN_RE,
  SESSION_TOUCH_INTERVAL_MS,
  MAX_SESSIONS_PER_USER,
  type SessionInfo,
} from './session';
export { passwordProblem, hashPassword, verifyPassword, BCRYPT_COST, PASSWORD_MIN_LENGTH } from './password';
export { checkLogin, recordLoginFailure, recordLoginSuccess } from './throttle';
export { attemptLogin, logoutEverywhere, changeOwnPassword, loginPhoneDigits, maskPhone, type ChangePasswordResult } from './login';
export { issueInvite, issuePasswordReset, inspectInvite, acceptInvite, revokePendingInvites, inviteLink } from './invites';
export { checkOrigin, originCheckRequired, SAFE_METHODS, ORIGIN_EXEMPT_PREFIXES } from './csrf';
export { sessionCookieSpec, sessionCookieNames } from './cookie';
export { readSecurityPolicy } from './policy';
export {
  loginRequest,
  logoutRequest,
  logoutAllRequest,
  changePasswordRequest,
  inspectInviteRequest,
  acceptInviteRequest,
} from './service';
