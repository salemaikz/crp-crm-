// Реестр выданных исполнителей: scopeSql принимает только объекты, созданные buildViewer() или
// systemActor(). Объект той же формы, собранный руками (например, в интерфейсе), будет отклонён.
import type { Actor } from './types';

const issued = new WeakSet<object>();

export function registerActor<T extends Actor>(actor: T): T {
  issued.add(actor);
  return actor;
}

/** Бросает, если исполнитель не выдан ядром доступа. */
export function assertIssued(actor: Actor): void {
  if (typeof actor !== 'object' || actor === null || !issued.has(actor)) {
    throw new Error('доступ: исполнитель не выдан buildViewer()/systemActor()');
  }
}
