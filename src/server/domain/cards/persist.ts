// Запись результата перехода карточки (docs/calls-design.md §4.4): строка calls, карточка по версии, флаги
// номеров и эффекты. Общая для итога звонка и порта записи (booking, D-133).
import type { calling } from '@crm/core';
import { applyCardEffects } from './effects';
import { insertCall, updateCardRow, updatePhoneFlags } from './repo';
import type { CallExtras, EffectCard, PersistTransition } from './types';

const NO_EXTRAS: CallExtras = { note: '', fieldsPatch: {}, tappedAt: null, durationSec: null, durationSource: 'none' };

export const persistTransition: PersistTransition = async (tx, actor, input) => {
  const { ctx, before, result, at } = input;
  const snap = before.snapshot;

  if (result.call) {
    const call = result.call;
    const x = input.call ?? NO_EXTRAS;
    const inserted = await insertCall(tx, {
      id: call.id,
      spaceId: before.spaceId,
      cardId: snap.id,
      clientId: snap.clientId,
      userId: call.userId,
      ownerUserIdAtCall: call.ownerUserIdAtCall,
      via: call.via,
      phoneDigits: call.phoneId ? (before.phoneDigits.get(call.phoneId) ?? '') : '',
      outcomeCode: call.outcomeCode,
      outcomeKind: call.outcomeKind,
      reasonCode: call.reasonCode,
      note: x.note,
      lpr: call.lpr,
      callbackAt: call.callbackAt,
      fieldsPatch: x.fieldsPatch,
      applied: call.applied,
      factReason: call.factReason,
      tappedAt: x.tappedAt,
      occurredAt: call.occurredAt,
      receivedAt: call.receivedAt,
      durationSec: x.durationSec,
      durationSource: x.durationSource,
      configRev: ctx.configRev,
    });
    // Под блокировкой карточки так не бывает: вызывающий откатит транзакцию, повтор ответит `duplicate`
    if (!inserted) throw new Error('duplicate_race');
  }

  const after = result.card;
  if (after.version !== snap.version) {
    if (!(await updateCardRow(tx, after, snap.version, at))) throw new Error('cards: версия карточки изменилась под блокировкой');
  }

  const changed = after.phones
    .filter((p) => {
      const old = snap.phones.find((o) => o.id === p.id);
      return old && (old.isWorking !== p.isWorking || old.isPrimary !== p.isPrimary);
    })
    .map((p) => ({ id: p.id, isWorking: p.isWorking, isPrimary: p.isPrimary }));
  if (changed.length > 0) await updatePhoneFlags(tx, snap.clientId, changed);

  const card: EffectCard = {
    id: snap.id,
    clientId: snap.clientId,
    spaceId: before.spaceId,
    ownerUserId: after.ownerUserId,
    actingUserId: after.actingUserId,
    phoneDigits: before.phoneDigits,
    ...(result.call ? { opId: result.call.id } : input.opId ? { opId: input.opId } : {}),
    priorOwnerUserId: snap.ownerUserId,
    priorActingUserId: snap.actingUserId,
  };
  await applyCardEffects(tx, actor, card, enrichCallEvents(result, input.call), at, ctx);
};

/** В событие `call` ленты — код итога, номер разговора и длительность (ядро отдаёт только вид и состояния). */
function enrichCallEvents(result: calling.AppliedResult | calling.FactOnlyResult, x: CallExtras | undefined): calling.Effects {
  const call = result.call;
  if (!call) return result.effects;
  return {
    ...result.effects,
    timeline: result.effects.timeline.map((e) =>
      e.kind === 'call' ? { ...e, data: { ...e.data, outcome: call.outcomeCode, phoneId: call.phoneId, durationSec: x?.durationSec ?? null } } : e,
    ),
  };
}
