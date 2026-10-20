// Санкционированная фабрика системного исполнителя для слоёв домена (D-231, ARCHITECTURE §2.2).
// systemActor() домену закрыт; этой фабрикой пользуются только каскады внутри уже заблокированной транзакции
// (отмена мероприятия): имя задачи — из закрытого списка, исполнитель попадает в тот же реестр assertIssued.
import type { SystemActor } from './types';
import { registerActor } from './registry';

/** Закрытый список имён «задач» для домена: новое имя — отдельное решение. */
export const DOMAIN_SYSTEM_JOBS = ['booking:event_cancel'] as const;
export type DomainSystemJob = (typeof DOMAIN_SYSTEM_JOBS)[number];

export function systemActorFor(job: DomainSystemJob, now: number): SystemActor {
  if (!(DOMAIN_SYSTEM_JOBS as readonly string[]).includes(job)) throw new Error('systemActorFor: имя задачи не входит в список домена');
  return registerActor(Object.freeze({ kind: 'system' as const, job, now }));
}
