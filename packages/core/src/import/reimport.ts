// Повторный импорт поверх существующих (PROCESS 12.14, D-048). Чистое решение по паре ключей.

export interface PriorImportRow {
  rowKey: string;
  /** Ключ состояния, с которым строка была применена в прошлый раз. */
  stateKey: string;
  /** Карточку после импорта вели в CRM (есть звонки/правки не от импорта). */
  touchedInCrm: boolean;
}

export type ReimportDecision =
  /** Строки нет в прошлых импортах: новая. */
  | 'new'
  /** Та же строка с тем же состоянием: пропуск, 0 изменений. */
  | 'skip'
  /** Состояние изменилось, карточку в CRM не трогали: один импортный звонок, состояние обновлено. */
  | 'update_state'
  /** Состояние изменилось, но карточку уже вели в CRM: «оставлено как в CRM», строка на разбор РОП. */
  | 'kept_in_crm';

export function decideReimport(row: { stateKey: string }, prior: PriorImportRow | undefined): ReimportDecision {
  if (!prior) return 'new';
  if (prior.stateKey === row.stateKey) return 'skip';
  return prior.touchedInCrm ? 'kept_in_crm' : 'update_state';
}
