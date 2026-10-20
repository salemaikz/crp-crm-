// Прикладной слой входа: открывает БД и транзакции, читает политику. Маршруты src/app/api/auth/**
// (в интерфейсе нет доступа к БД) только разбирают тело, зовут эти функции и ставят cookie.
// Когда обёртки P4a (route/publicRoute) появятся, маршруты перейдут на них, а логика останется здесь.
import { getDb } from '../db';
import { rateLimit } from '../ratelimit';
import { acceptInvite, inspectInvite } from './invites';
import { attemptLogin, changeOwnPassword, logoutEverywhere, type ChangePasswordResult } from './login';
import { readPhoneRules, readSecurityPolicy } from './policy';
import { revokeSessionByToken } from './session';
import type { InvitePreview, LoginResult } from './types';

/** Приглашения: 30 запросов за 15 мин с IP на inspect и accept вместе (бережёт CPU bcrypt). */
const INVITE_LIMIT = 30;
const INVITE_WINDOW_MS = 15 * 60_000;

export async function loginRequest(input: { phone: string; password: string; next?: string | null; ip: string }): Promise<LoginResult> {
  const policy = await readSecurityPolicy();
  const rules = await readPhoneRules();
  const db = await getDb();
  return db.tx((sql) => attemptLogin(sql, input, policy, Date.now(), rules));
}

export async function logoutRequest(token: string | null): Promise<void> {
  const db = await getDb();
  await revokeSessionByToken(db.sql, token);
}

export async function logoutAllRequest(userId: string): Promise<{ revoked: number }> {
  const db = await getDb();
  return db.tx((sql) => logoutEverywhere(sql, userId, Date.now()));
}

export async function changePasswordRequest(input: { userId: string; current: string; next: string }): Promise<ChangePasswordResult> {
  const policy = await readSecurityPolicy();
  const db = await getDb();
  return db.tx((sql) => changeOwnPassword(sql, input, policy, Date.now()));
}

export type InviteInspectResult = { ok: true; preview: InvitePreview } | { ok: false; error: 'invalid_token' | 'rate_limited'; retryAfterMs?: number };

export async function inspectInviteRequest(input: { token: string; ip: string }): Promise<InviteInspectResult> {
  const limit = rateLimit(`invite:${input.ip}`, INVITE_LIMIT, INVITE_WINDOW_MS);
  if (!limit.ok) return { ok: false, error: 'rate_limited', retryAfterMs: limit.retryAfterMs };
  const db = await getDb();
  const preview = await inspectInvite(db.sql, input.token, Date.now());
  return preview ? { ok: true, preview } : { ok: false, error: 'invalid_token' };
}

export async function acceptInviteRequest(input: { token: string; password: string; ip: string }) {
  const limit = rateLimit(`invite:${input.ip}`, INVITE_LIMIT, INVITE_WINDOW_MS);
  if (!limit.ok) return { ok: false as const, error: 'rate_limited' as const, retryAfterMs: limit.retryAfterMs };
  const policy = await readSecurityPolicy();
  const db = await getDb();
  return db.tx((sql) => acceptInvite(sql, { token: input.token, password: input.password, policy, nowMs: Date.now() }));
}
