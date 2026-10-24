// Подсказка первого входа на доску: путь и ключ отметки. Чистый модуль, чтобы клиентский компонент и тесты не расходились.
export const BOARD_TIP_PATH = '/board';

/** Ключ localStorage: версия подсказки и идентификатор сотрудника (ни имени, ни телефона). */
export function boardTipKey(userId: string): string {
  return `crm.tip.board.v1:${userId}`;
}
