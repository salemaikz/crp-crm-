// scopeSql — единственный способ получить фильтр «своё / команда / пространство / все + отношения»
// к сущностям с данными клиентов (ARCHITECTURE §5.2 п. 4–7, D-017). Импортируют только домен и
// доступ (ESLint, layers.test.ts). Реализация — P4a, этап 2.
import type { Permission } from '@crm/core/access';
import type { Row, Sql } from '@/server/platform/db';
import type { Actor, ScopedEntity } from './types';

declare const FRAGMENT: unique symbol;

/** Непрозрачный SQL-фрагмент охвата. Собирается только здесь; вставляется через `scoped(sql)`. */
export interface ScopeFragment {
  readonly [FRAGMENT]: true;
}

export type ScopeOptions = {
  /** Псевдоним таблицы во внешнем запросе; по умолчанию — ENTITY_TABLES[entity].alias. */
  alias?: string;
};

/** Таблица и псевдоним по умолчанию для каждой охватываемой сущности. */
export const ENTITY_TABLES: Readonly<Record<ScopedEntity, { table: string; alias: string }>> = {
  card: { table: 'cards', alias: 'c' },
  client: { table: 'clients', alias: 'cl' },
  contact: { table: 'contacts', alias: 'ct' },
  client_phone: { table: 'client_phones', alias: 'cp' },
  deal: { table: 'deals', alias: 'd' },
  booking: { table: 'bookings', alias: 'b' },
  call: { table: 'calls', alias: 'ca' },
  note: { table: 'notes', alias: 'n' },
  client_event: { table: 'client_events', alias: 'ev' },
  task: { table: 'tasks', alias: 't' },
  handoff: { table: 'handoffs', alias: 'h' },
  messenger_chat: { table: 'messenger_chats', alias: 'mc' },
  event: { table: 'events', alias: 'e' },
};

/**
 * Фрагмент WHERE для строк `entity` (под псевдонимом alias), доступных исполнителю по разрешению
 * `perm`. Нет доступа — `FALSE`; SystemActor — `TRUE`. Для пишущих `perm` отношения дают только
 * свои действия, а роль «только чтение» — `FALSE`. Ставится и в SELECT, и в UPDATE/DELETE.
 */
export function scopeSql(actor: Actor, entity: ScopedEntity, perm: Permission, opts: ScopeOptions = {}): ScopeFragment {
  void actor;
  void entity;
  void perm;
  void opts;
  throw new Error('scopeSql: P4a, этап 2');
}

/** Тег запроса, который принимает ScopeFragment среди значений: `scoped(sql)\`… AND ${scope}\``. */
export type ScopedSql = <T = Row>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T[]>;

export function scoped(sql: Sql): ScopedSql {
  void sql;
  throw new Error('scoped: P4a, этап 2');
}

/**
 * После UPDATE … WHERE id = $1 AND <scope> AND version = $v, обновившего 0 строк: повторное чтение
 * с охватом чтения. Не видна — NotFoundError (404), видна — ConflictError (409). Всегда бросает.
 */
export async function throwNotFoundOrConflict(actor: Actor, sql: Sql, entity: ScopedEntity, id: string): Promise<never> {
  void actor;
  void sql;
  void entity;
  void id;
  throw new Error('throwNotFoundOrConflict: P4a, этап 2');
}
