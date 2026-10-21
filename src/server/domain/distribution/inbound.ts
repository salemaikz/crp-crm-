// Владелец новой карточки из входящего сообщения (O7a, D-271, дизайн docs/reports-plugins-design.md §8.6). Правило
// `channel_owner_then_least_loaded`: владелец канала, если он активный участник раздачи; иначе в рабочее время —
// участник с наименьшим числом выдач сегодня; иначе карточка остаётся в пуле (раздаст тик), задачу получит РОП.
// Вызывается внутри транзакции приёма (intake/inbound.ts): блокировку приёма уже взяли. Лимит дня входящие не режут.
import type { SystemActor } from '@/server/access';
import type { Sql } from '@/server/platform/db';
import { distributionDeps } from './deps';
import { isReadyParticipant, leastLoadedParticipant, writeInboundAssignment } from './repo';

export interface InboundAssignInput {
  spaceId: string;
  cardId: string;
  clientId: string;
  /** Владелец канала, через который пришло сообщение (null — канал пула). */
  preferredUserId: string | null;
  /** Сейчас рабочий день и рабочие часы (`calendar.workHours`): считает вызывающий по календарю установки. */
  workingNow: boolean;
  now: number;
}

export type InboundAssignResult = { ownerUserId: string | null; mode: 'channel_owner' | 'least_loaded' | 'pool' };

export async function assignInbound(tx: Sql, _actor: SystemActor, input: InboundAssignInput): Promise<InboundAssignResult> {
  const cfg = await distributionDeps().config(input.spaceId, input.now);
  const day = cfg.calendar.localDay(input.now);
  const roles = cfg.participantRoles;
  const countsToCap = cfg.settings.capIncludes.includes('inbound');

  let owner: string | null = null;
  let mode: InboundAssignResult['mode'] = 'pool';
  if (input.preferredUserId && (await isReadyParticipant(tx, { spaceId: input.spaceId, userId: input.preferredUserId, roles, today: day }))) {
    owner = input.preferredUserId;
    mode = 'channel_owner';
  } else if (input.workingNow) {
    owner = await leastLoadedParticipant(tx, { spaceId: input.spaceId, roles, today: day });
    if (owner) mode = 'least_loaded';
  }
  if (!owner) return { ownerUserId: null, mode: 'pool' };
  const written = await writeInboundAssignment(tx, { spaceId: input.spaceId, cardId: input.cardId, clientId: input.clientId, toUserId: owner, now: input.now, day, countsToCap });
  return written ? { ownerUserId: owner, mode } : { ownerUserId: null, mode: 'pool' };
}
