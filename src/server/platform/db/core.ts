// Общие типы слоя БД и служебные части драйверов. Источник: платформа LMS 2cd8a2b src/lib/db/core.ts.
import { AsyncLocalStorage } from 'node:async_hooks';

export type Row = Record<string, unknown>;

export interface Sql {
  <T = Row>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
}

/** Выделенное соединение из пула (сессионные advisory-блокировки воркера). release() возвращает его в пул. */
export interface ReservedConn {
  sql: Sql;
  release(): Promise<void>;
}

export interface Db {
  sql: Sql;
  /** Занять отдельное соединение на время сессионной блокировки. Только драйвер postgres. */
  reserve?(): Promise<ReservedConn>;
  /**
   * Транзакция. Внутри колбэка любой вызов db.sql/db.tx тоже идёт в эту транзакцию.
   * Вложенный db.tx — SAVEPOINT: ошибка внутри откатывает только вложенную часть, и если её
   * поймать (например, isUniqueViolation), внешняя транзакция продолжает работать.
   * Соседние вложенные db.tx одной транзакции выполняются по очереди.
   */
  tx<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
  /** Параметр для колонок jsonb: ${db.json(v)}. */
  json(value: unknown): unknown;
  driver: 'postgres';
}

/** Соединение внутри транзакции с доступом к многооператорным скриптам (миграции, сид). */
export interface TxConn {
  sql: Sql;
  exec(script: string): Promise<void>;
  /**
   * Точка сохранения внутри этой транзакции: fn выполняется после SAVEPOINT; при ошибке —
   * ROLLBACK TO SAVEPOINT и ошибка пробрасывается дальше. Есть только у соединений транзакции.
   */
  savepoint?<T>(fn: (conn: TxConn) => Promise<T>): Promise<T>;
}

/** Внутренний интерфейс: то, что нужно миграциям, сиду и тестам. Приложение работает с Db. */
export interface DbHandle extends Db {
  /** Скрипт из нескольких команд без параметров. Только для миграций. */
  exec(script: string): Promise<void>;
  /** Транзакция с exec. Только для миграций и сида. */
  withTx<T>(fn: (conn: TxConn) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Бренд jsonb-параметра. Symbol.for общий для всех копий модуля: Next собирает core.ts отдельно в
 * каждый бандл, а драйвер создаётся один раз на процесс — `instanceof` между бандлами не работает.
 */
const JSON_BRAND = Symbol.for('crm.jsonParam');

/** Маркер jsonb-параметра; драйвер превращает его в типизированный параметр jsonb. */
export class JsonParam {
  readonly [JSON_BRAND] = true;
  constructor(readonly value: unknown) {}
}

/** Проверка по бренду, а не по классу: работает и для параметра из чужого бандла. */
export function isJsonParam(v: unknown): v is JsonParam {
  return typeof v === 'object' && v !== null && (v as Record<symbol, unknown>)[JSON_BRAND] === true;
}

export function jsonParam(value: unknown): JsonParam {
  if (value === undefined) throw new Error('db.json(undefined) is not allowed');
  return new JsonParam(value);
}

/** snake_case → camelCase, ровно как postgres.toCamel (для одинаковых ключей в обоих драйверах). */
export function toCamel(x: string): string {
  let str = x[0] ?? '';
  for (let i = 1; i < x.length; i++) {
    const ch = x[i];
    if (ch === '_' && i + 1 < x.length) str += (x[++i] as string).toUpperCase();
    else str += ch;
  }
  return str;
}

/**
 * Область транзакции на AsyncLocalStorage: вызовы db.sql/db.tx изнутри колбэка транзакции
 * уходят в ту же транзакцию. Без этого запрос изнутри колбэка занял бы другое соединение пула
 * и выполнился бы мимо транзакции.
 *
 * Вложенная транзакция (withTx внутри withTx) — SAVEPOINT текущего соединения (conn.savepoint).
 * Соседние вложенные транзакции одной области выполняются строго по очереди: точки сохранения
 * на одном соединении образуют стек, параллельные SAVEPOINT/ROLLBACK TO перепутали бы его.
 */
export function createTxScope() {
  type Store = { conn: TxConn; done: boolean; parent: Store | null; chain: Promise<void> };
  const als = new AsyncLocalStorage<Store>();
  const active = (): Store | null => {
    let s = als.getStore() ?? null;
    // запрос, «забытый» после конца вложенной области, идёт в родительскую транзакцию
    while (s && s.done) s = s.parent;
    return s;
  };
  const enter = async <T>(conn: TxConn, parent: Store | null, fn: (conn: TxConn) => Promise<T>): Promise<T> => {
    const store: Store = { conn, done: false, parent, chain: Promise.resolve() };
    try {
      return await als.run(store, () => fn(conn));
    } finally {
      // запросы, «забытые» после конца транзакции, пойдут уже мимо неё
      store.done = true;
    }
  };
  return {
    current(): TxConn | null {
      return active()?.conn ?? null;
    },
    /** Корневая транзакция: conn — соединение уже открытой транзакции драйвера. */
    run<T>(conn: TxConn, fn: (conn: TxConn) => Promise<T>): Promise<T> {
      return enter(conn, null, fn);
    },
    /** Вложенная транзакция в текущей области (SAVEPOINT). Вызывать, только если current() не null. */
    async nested<T>(fn: (conn: TxConn) => Promise<T>): Promise<T> {
      const parent = active();
      if (!parent) throw new Error('nested transaction outside of a transaction');
      const conn = parent.conn;
      if (!conn.savepoint) throw new Error('driver connection does not support savepoints');
      const prev = parent.chain;
      let release!: () => void;
      parent.chain = new Promise<void>((r) => (release = r));
      await prev;
      try {
        return await conn.savepoint<T>((sp) => enter(sp, parent, fn));
      } finally {
        release();
      }
    },
  };
}

/** Нарушение уникальности (код Postgres 23505) — одинаково для обоих драйверов. */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}
