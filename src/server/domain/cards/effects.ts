// Исполнитель `calling.Effects` (docs/calls-design.md §5). Порядок групп фиксирован: задачи → сделки → записи →
// стоп-лист → журнал раздачи → уведомления → лента → аудит → пропуски; внутри группы — порядок ядра.
// Карточку заблокировал и проверил вызывающий; охвата здесь нет.
import { access as coreAccess, type calling } from '@crm/core';
import type { RoleConfig } from '@crm/core/access';
import { resolvers } from '@/server/access/context';
import { applyBookingEffects } from '@/server/domain/booking/effects';
import { applyDealEffects } from '@/server/domain/deals/effects';
import { closeAutoTaskByKey, closeAutoTasks, ensureAutoTask, reassignOpenTasks } from '@/server/domain/tasks/auto';
import { newId, type Sql } from '@/server/platform/db';
import { isProduction } from '@/server/platform/env';
import {
  actorUserId,
  addToStopList,
  findLead,
  insertAssignLog,
  insertClientEvent,
  insertNotification,
  insertSkipRow,
  removeFromStopList,
  writeCardAudit,
} from './repo';
import type { ApplyCardEffects, ResolveLead } from './types';

const { RolesSchema, roleGrants } = coreAccess;

let dealExecutor: typeof applyDealEffects = applyDealEffects;

/**
 * Только тесты: подменить исполнитель сделок. Нужен, пока `lose_open` в deals/effects.ts не реализован (B6, 23.10):
 * без него итоги «Не интересно», «Не целевой» и «Просил не звонить» падают. В production — ошибка.
 */
export function overrideDealEffectsForTests(fn: typeof applyDealEffects | null): void {
  if (isProduction()) throw new Error('cards: подмена исполнителя сделок запрещена в production');
  dealExecutor = fn ?? applyDealEffects;
}

const leadRolesCache = new WeakMap<object, string[]>();

/** Роли, дающие `task.read` с охватом space/all: из них выбирается руководитель (D-176). */
async function leadRoleKeys(): Promise<string[]> {
  const cfg = (await resolvers().config()) as { global?: { roles?: unknown } } | null;
  if (!cfg || typeof cfg !== 'object' || !cfg.global) return [];
  const hit = leadRolesCache.get(cfg);
  if (hit) return hit;
  const parsed = RolesSchema.safeParse(cfg.global.roles);
  const scopeOk = (r: RoleConfig, perm: 'task.read' | 'card.outcome') => {
    const s = roleGrants(r).get(perm);
    return s === 'space' || s === 'all';
  };
  const leads = parsed.success ? parsed.data.filter((r) => !r.archived && scopeOk(r, 'task.read')) : [];
  // Роли, которые ещё и ведут карточки (РОП), раньше ролей только с просмотром (директор): задача уйдёт тому, кто может по ней работать
  const keys = [...leads.filter((r) => scopeOk(r, 'card.outcome')), ...leads.filter((r) => !scopeOk(r, 'card.outcome'))].map((r) => r.key);
  leadRolesCache.set(cfg, keys);
  return keys;
}

export const resolveLead: ResolveLead = async (tx, input) => findLead(tx, { spaceId: input.spaceId, ownerUserId: input.ownerUserId, roleKeys: await leadRoleKeys() });

async function recipient(tx: Sql, to: calling.Recipient, card: { spaceId: string; ownerUserId: string | null }, at: number): Promise<string | null> {
  if ('user' in to) return to.user;
  return resolveLead(tx, { spaceId: card.spaceId, ownerUserId: card.ownerUserId, at });
}

const digitsOf = (card: { phoneDigits: ReadonlyMap<string, string> }, phoneId: string): string => {
  const d = card.phoneDigits.get(phoneId);
  if (d === undefined) throw new Error('cards: номер эффекта не принадлежит карточке');
  return d;
};

export const applyCardEffects: ApplyCardEffects = async (tx, actor, card, effects, at, ctx) => {
  const me = actorUserId(actor);
  const opId = card.opId;

  // --- задачи ---
  for (const e of effects.tasks) {
    if (e.op === 'create') {
      const assignee = await recipient(tx, e.assignee, card, at);
      if (assignee === null) {
        // Руководителя нет: задача не создаётся, предупреждение без ПДн (D-176)
        console.warn(`[cards] нет получателя задачи ${e.source}`);
        continue;
      }
      await ensureAutoTask(tx, actor, { spaceId: card.spaceId, clientId: card.clientId, source: e.source, kind: e.kind, assigneeUserId: assignee, dueAt: e.dueAt, sourceKey: e.sourceKey, at });
    } else if (e.op === 'close') {
      await closeAutoTasks(tx, actor, { spaceId: card.spaceId, clientId: card.clientId, sources: e.sources, at });
    } else if (e.op === 'close_by_key') {
      await closeAutoTaskByKey(tx, actor, { sourceKey: e.sourceKey, at });
    } else {
      await reassignOpenTasks(tx, actor, { spaceId: card.spaceId, clientId: card.clientId, toUserId: e.to, at });
    }
  }

  // --- сделки и записи ---
  if (effects.deals.length > 0) await dealExecutor(tx, actor, card, effects.deals, at);
  if (effects.bookings.length > 0) await applyBookingEffects(tx, actor, card, effects.bookings, at);

  // --- стоп-лист ---
  for (const e of effects.stopList) {
    const digits = digitsOf(card, e.phoneId);
    if (e.op === 'add') await addToStopList(tx, { digits, reasonCode: e.reasonCode, createdBy: me, at });
    else await removeFromStopList(tx, digits);
  }

  // --- журнал раздачи ---
  for (const e of effects.assignLog) {
    await insertAssignLog(tx, {
      spaceId: card.spaceId,
      cardId: card.id,
      fromUserId: e.fromUserId,
      toUserId: e.toUserId,
      kind: e.kind,
      countsToCap: e.countsToCap,
      runId: opId ?? newId(),
      day: ctx.calendar.localDay(at),
      actorId: me,
      at,
    });
  }

  // --- уведомления ---
  for (const e of effects.notifications) {
    const to = await recipient(tx, e.to, card, at);
    if (to === null) continue;
    await insertNotification(tx, { userId: to, kind: e.kind, entityType: 'card', entityId: card.id, dedupeKey: e.dedupeKey, at });
  }

  // --- лента ---
  for (const e of effects.timeline) {
    await insertClientEvent(tx, {
      clientId: card.clientId,
      spaceId: card.spaceId,
      kind: e.kind,
      actorId: e.actorId,
      at: e.at,
      refType: e.ref?.type ?? '',
      refId: e.ref?.id ?? '',
      data: e.data,
    });
  }

  // --- аудит ---
  for (const e of effects.audit) {
    await writeCardAudit(tx, { actorId: me, action: e.kind === 'dnc.cleared' ? 'card.dnc_cleared' : 'card.merged', cardId: card.id, spaceId: card.spaceId, meta: e.data, at });
  }

  // --- пропуски ---
  for (const e of effects.skips) {
    if (me === null) throw new Error('cards: пропуск без сотрудника');
    await insertSkipRow(tx, { id: e.opId, spaceId: card.spaceId, userId: me, cardId: card.id, day: e.day, at });
  }
};
