// Журнал действий (audit_log): общий писатель. Таблица только для добавления: у crm_app нет UPDATE и
// DELETE (ARCHITECTURE §4.1). ПДн в аудит не пишутся — только id и коды (§4.6).
// Источник: платформа LMS 2cd8a2b src/lib/audit.ts, список действий свой.
import { newId, now, type Sql } from './db';
import { jsonParam } from './db/core';

export type AuditEntity = 'user' | 'session' | 'config' | 'license' | 'system' | 'event' | 'series' | 'ingest_key' | 'distribution' | 'card' | 'export' | 'integration' | 'messenger' | 'resource' | 'deal' | 'proposal' | 'client' | 'pair';

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
  // B2: мероприятия и серии записи (без ПДн в meta)
  'event.create',
  'event.update',
  'event.cancel',
  'event.duty',
  'series.create',
  'series.update',
  // B4: гость без записи с номером из стоп-листа (в meta — только id мероприятия)
  'booking.walk_in_skipped',
  // B5a: консультанты (в meta — id, коды и числа)
  'consultant.create',
  'consultant.update',
  // B5b: недельный график и исключения по датам
  'consultant.schedule',
  // B6: покупка, её правка и отмена (в meta — id, коды, суммы в тенге и моменты; без ПДн и текста комментария)
  'deal.purchase',
  'deal.purchase_edit',
  'deal.purchase_cancel',
  // C3: ключи приёма; значение ключа и его хэш в журнал не попадают, только prefix
  'ingest_key.create',
  'ingest_key.revoke',
  // C6a: раздача (без ПДн в meta)
  'distribution.issue',
  'distribution.participant',
  // C6b: отсутствие, пауза, раздел «без владельца» (в meta — коды и числа)
  'distribution.absence',
  'distribution.absence_cancel',
  'distribution.pause',
  'distribution.ownerless_assign',
  // C5: карточка обзвона (без ПДн в meta)
  'card.dnc_cleared',
  'card.merged',
  // O7a: подключения интеграций и окно чата Wazzup (в meta — коды, id каналов; без ключей, адресов вебхука и ссылок)
  'integration.connect',
  'integration.crossborder',
  'integration.enable',
  'integration.disable',
  'integration.revoke_webhook',
  'integration.channel',
  'messenger.open_chat',
  // C9: возврат в обзвон и разбор «Предложить контакт» (в meta — коды и id, без ПДн)
  'card.reopen',
  'proposal.resolve',
  // B9a: передача клиентов (в meta — числа и коды режима, без имён)
  'client.transfer',
  // B9b: слияние клиентов и решение по спорной паре (в meta — id, коды и счётчики, без ПДн)
  'client.merge',
  'pair.resolve',
  // P10: лицензия (в meta — lid, kid, коды состояний и причин, часы в часах; без ПДн)
  'license.install',
  'license.state_change',
  'license.clock_jump',
  // R3b: журнал выгрузок (PROCESS 8.6). В meta — только kind, reportKey, format, rows, filterKeys, periodDays
  'export.report',
  'export.full',
  'export.guests',
  // D-294: полная выгрузка дописана до конца (лимит в сутки считает только такие); в meta — только rows
  'export.full_done',
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
