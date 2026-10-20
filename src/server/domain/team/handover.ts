// Передача дел при отключении сотрудника. ЗАГЛУШКА-ИНТЕРФЕЙС для B9a/R3 «Срочное отключение» (D-066).
//
// TODO(B9a, D-066): реальная реализация внутри той же транзакции отключения:
//  - `urgent`: new без звонков -> пул; retry/callback/agreed/client -> тот, кто отключает (охват space),
//    иначе первый активный сотрудник роли `team.fallbackOwnerRole`; будущие записи и открытые задачи -> ему же;
//    тревога «Разберите дела сотрудника: K карточек»;
//  - `wizard`: выбор получателя или поровну (PROCESS 12.15).
// Инвариант D-066: после отключения нет карточки рабочего состояния без владельца, кроме `new`.
// Пока реализации нет, отключение закрывает вход и сессии, но дела НЕ переносит: интерфейс показывает
// администратору предупреждение (status = 'not_implemented').
import type { Sql } from '@/server/platform/db';

export type HandoverMode = 'urgent' | 'wizard';

export type HandoverInput = {
  /** Кто отключает: он и получает дела в срочном режиме. */
  actorId: string;
  userId: string;
  spaceId: string | null;
  mode: HandoverMode;
  nowMs: number;
};

export type HandoverResult = {
  status: 'done' | 'not_implemented';
  /** Сколько карточек получило нового владельца (без ПДн, для аудита и тревоги). */
  movedCards: number;
};

export interface StaffHandover {
  /** Вызывается в транзакции отключения, после закрытия сессий. */
  run(sql: Sql, input: HandoverInput): Promise<HandoverResult>;
}

/** Ничего не переносит. Заменяется реализацией B9a. */
export const stubHandover: StaffHandover = {
  run: async () => ({ status: 'not_implemented', movedCards: 0 }),
};
