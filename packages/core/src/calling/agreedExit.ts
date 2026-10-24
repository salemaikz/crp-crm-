// № 33. Выход из «Договорились» без звонка (pipeline-v2 §3.3, D-336): в перезвон, «Не заинтересован» или «Списан».
// Явку по записи открытой сделки сервер отмечает в той же транзакции через порт записи без события карточки
// и передаёт ядру факт; здесь только решение и эффекты. Чистая функция: время и календарь приходят параметрами.

import type {
  AgreedExitEvent,
  CallingSettings,
  CardSnapshot,
  ReasonDef,
  TimelineEffect,
  TransitionInput,
  TransitionResult,
} from './spec/types.js';
import {
  applied,
  callbackTask,
  closeEffects,
  commit,
  emptyEffects,
  MINUTE_MS,
  ownerRecipient,
  reject,
  tlState,
  writeOffEffects,
} from './transitionKit.js';

/** Причина должна быть в группе (архивная допустима) и ручная; нет группы в настройках — проверка не нужна. */
function reasonKnown(group: 'callback' | 'not_interested' | 'written_off', code: string, settings: CallingSettings): boolean {
  const list = (settings.reasons as Record<string, ReasonDef[] | undefined> | undefined)?.[group];
  if (list === undefined) return true;
  const r = list.find((x) => x.code === code);
  return r !== undefined && r.manual !== false;
}

export function applyAgreedExit(input: TransitionInput, card: CardSnapshot, e: AgreedExitEvent): TransitionResult {
  const { now, actor, settings, calendar } = input;
  if (card.state !== 'agreed') return reject('invalid_transition');
  // Причина обязательна у закрытий всегда, у перезвона — по `calling.callbackReason`
  const needReason = e.to !== 'callback' || settings.callbackReason?.required === true;
  if (e.reasonCode.trim() === '') {
    if (needReason) return reject('reason_required', 'reasonCode');
  } else if (!reasonKnown(e.to, e.reasonCode, settings)) {
    return reject('reason_unknown', 'reasonCode');
  }

  const effects = emptyEffects();
  const ref = { type: 'card_move' as const, id: e.opId };
  // В данных события — код причины (не ПДн): по нему отчёт «Причины» видит и «не придёт», и прочие причины № 33
  const timeline = (to: 'callback' | 'not_interested' | 'written_off'): TimelineEffect => {
    const base = tlState(now, actor.userId, 'agreed', to, 'agreed_exit');
    return { ...base, ref, data: { ...base.data, reasonCode: e.reasonCode } };
  };

  if (e.to === 'callback') {
    if (e.callbackAt === null) return reject('callback_at_required', 'callbackAt');
    const precision = e.callbackPrecision ?? 'time';
    // Точность «день»: сравниваются сутки, сегодняшний срок допустим
    const past =
      precision === 'day'
        ? calendar.localDay(e.callbackAt) < calendar.localDay(now)
        : e.callbackAt < now - settings.callbackPastToleranceMin * MINUTE_MS;
    if (past) return reject('callback_in_past', 'callbackAt');

    // Договорённость закрыта: задачи следующего шага и договорённости больше не нужны
    effects.tasks.push({ op: 'close', sources: ['next_step', 'agreement'] });
    const att = e.attendance;
    if (att?.to === 'no_show') {
      effects.tasks.push({
        op: 'create',
        source: 'no_show',
        kind: 'call',
        assignee: ownerRecipient(card),
        dueAt: e.callbackAt,
        sourceKey: `no_show:${att.bookingId}`,
        ...(precision === 'day' ? { duePrecision: 'day' as const } : {}),
      });
      effects.deals.push({ op: 'set_needs_rebook', bookingId: att.bookingId, value: true });
    } else {
      effects.tasks.push(callbackTask(card, e.opId, e.callbackAt, precision));
      if (att?.to === 'attended') {
        // Только вперёд, как № 18: «пришёл, не купил» стоит на этапе «Пришёл»
        effects.deals.push({ op: 'advance', stage: 'on_attended', bookingId: att.bookingId });
      } else if (e.facts.futureBookingIds.length > 0) {
        // Явки нет: будущая запись снимается, сделка получает значок «нужна перезапись»
        for (const bookingId of e.facts.futureBookingIds) effects.deals.push({ op: 'set_needs_rebook', bookingId, value: true });
        effects.bookings.push({ op: 'cancel_future', reason: 'client' });
      }
    }
    effects.timeline.push(timeline('callback'));
    const result = applied(
      commit(card, {
        state: 'callback',
        attempts: 0,
        nextCallAt: e.callbackAt,
        nextCallPrecision: precision,
        callbackReason: e.reasonCode,
        callbackTouches: card.callbackTouches + 1,
        touchedInCrm: true,
      }),
      effects,
    );
    // Срок вне окна звонков — предупреждение, как у итога «Перезвонить»
    if (!calendar.isInCallWindow(e.callbackAt)) result.warnings.push('callback_outside_work_hours');
    return result;
  }

  // Закрытия: сделки проигрываются без advance, будущие записи снимаются
  const common = { attempts: 0, closeReasonCode: e.reasonCode, closedAt: now, nextCallAt: null, touchedInCrm: true };
  if (e.to === 'not_interested') {
    const closing = closeEffects('not_interested', e.reasonCode);
    effects.tasks.push(...closing.tasks);
    effects.deals.push(...closing.deals);
    effects.bookings.push({ op: 'cancel_future', reason: 'client' });
    effects.timeline.push(timeline('not_interested'));
    const days = settings.returnDays.not_interested;
    const returnAt = days === null ? null : calendar.addDays(now, days);
    return applied(commit(card, { ...common, state: 'not_interested', returnAt }), effects);
  }
  const closing = writeOffEffects(e.reasonCode, settings);
  effects.tasks.push(...closing.tasks);
  effects.deals.push(...closing.deals);
  effects.bookings.push({ op: 'cancel_future', reason: 'client' }, ...closing.bookings);
  effects.timeline.push(timeline('written_off'));
  return applied(commit(card, { ...common, state: 'written_off', returnAt: null }), effects);
}
