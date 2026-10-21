// Что видит отдел, которому передан клиент (D-300, уточняет D-249/D-250; вопрос владельцу — дизайн §13.2).
// Сделку отделу открывают только отношения передачи (`handoff_to_my_team`, `handoff_assigned_to_me`). Зритель, у
// которого `deal.read` есть лишь от них (нет охвата роли и других отношений, например окна консультанта), видит
// только сделку самой передачи и без денег: суммы и денежных полей истории нет.
import { scopeOf, type Viewer } from '@/server/access';

const DEPARTMENT_RELATIONS: ReadonlySet<string> = new Set(['handoff_to_my_team', 'handoff_assigned_to_me']);

/** Денежные ключи событий сделки (`deal.won`, `deal.purchase_edited`): отделу они не отдаются. */
export const MONEY_KEYS: ReadonlySet<string> = new Set(['amountKzt', 'fromAmount', 'toAmount']);

/** `deal.read` у зрителя только от отношений передачи. */
export function seesDealsOnlyAsDepartment(v: Viewer): boolean {
  if (scopeOf(v, 'deal.read') !== null) return false;
  const readers = v.relations.filter((r) => r.reads.includes('deal.read'));
  return readers.length > 0 && readers.every((r) => DEPARTMENT_RELATIONS.has(r.key));
}

/** Данные события истории без денежных ключей. */
export function withoutMoney(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([k]) => !MONEY_KEYS.has(k)));
}
