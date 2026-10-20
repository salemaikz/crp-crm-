// Журнал действий (audit_log): общий писатель. Таблица только для добавления: у crm_app нет UPDATE и
// DELETE (ARCHITECTURE §4.1). ПДн в аудит не пишутся — только id и коды (§4.6).
// Источник: платформа LMS 2cd8a2b src/lib/audit.ts, список действий свой.
import { newId, now, type Sql } from './db';
import { jsonParam } from './db/core';

export type AuditEntity = 'user' | 'session' | 'config' | 'license' | 'system' | 'card';

/**
 * Реестр имён действий. Имя — «<сущность>.<глагол_snake>» в два сегмента, первый совпадает с
 * сущностью. Новое действие = строка здесь; модули добавляют свои строки вместе со своим кодом.
 */
export const AUDIT_ACTIONS = [
  'system.migrate',
  'session.login',
  'session.logout',
  'session.logout_all',
  'config.write',
  'config.preset',
  'config.rollback',
  'config.migrate',
  'user.invite',
  'user.invite_accept',
  'user.password_reset_issue',
  'user.password_reset',
  'user.password_change',
  // R2a: сотрудники (без ПДн в meta)
  'user.invite_revoke',
  'user.role_change',
  'user.admin_change',
  'user.disable',
  // C5: карточка обзвона (без ПДн в meta)
  'card.dnc_cleared',
  'card.merged',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * Вставка в транзакции вызывающего. actorId NULL — система, воркер, CLI.
 * В meta — id, коды, счётчики; без имён, телефонов и токенов.
 */
export async function writeAudit(
  sql: Sql,
  e: {
    actorId: string | null;
    action: AuditAction;
    entity: AuditEntity;
    entityId: string;
    /** Пространство, если действие относится к нему. */
    spaceId?: string | null;
    meta?: Record<string, unknown>;
    /** Время записи (epoch-мс); по умолчанию now(). */
    createdAt?: number;
  },
): Promise<void> {
  await sql`
    INSERT INTO audit_log (id, actor_id, space_id, action, entity, entity_id, meta, created_at)
    VALUES (${newId()}, ${e.actorId}, ${e.spaceId ?? null}, ${e.action}, ${e.entity}, ${e.entityId},
            ${jsonParam(e.meta ?? {})}, ${e.createdAt ?? now()})`;
}
