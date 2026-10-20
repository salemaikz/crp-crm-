// Исполнитель для ядра `calling` (docs/calls-design.md §3): охват карточек сотрудника.
import type { calling } from '@crm/core';
import { scopeOf } from '@/server/access';
import type { CardActor } from './types';

/** own → own; team/space/all → space; нет охвата → relation (дежурный, консультант); система → space без userId. */
export function toCoreActor(actor: CardActor): calling.Actor {
  if (actor.kind === 'system') return { userId: null, kind: 'system', scope: 'space' };
  const scope = scopeOf(actor, 'card.outcome');
  return { userId: actor.userId, kind: 'user', scope: scope === 'own' ? 'own' : scope === null ? 'relation' : 'space' };
}
