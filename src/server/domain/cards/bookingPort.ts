// Порт карточки для записи (docs/calls-design.md §9, booking-design §7.1): событие записи → снимок →
// calling.applyOutcome → запись перехода. Карточку заблокировал и проверил booking, поэтому здесь нет ни
// повторной блокировки, ни охвата. `rejected` не бросается: решает вызывающий.
import { calling } from '@crm/core';
import type { CardPort } from '@/server/domain/booking/types';
import { toCoreActor } from './actor';
import { persistTransition } from './persist';
import { loadSnapshot } from './repo';
import { loadCallingContext } from './settings';
import type { CreateCardBookingPort, LoadCallingContext } from './types';

export const createCardBookingPort: CreateCardBookingPort = (load: LoadCallingContext): CardPort => ({
  async applyBookingEvent(tx, actor, card, event, now) {
    const row = await loadSnapshot(tx, card.id);
    if (!row) return { status: 'rejected', error: 'not_found', field: null };
    const ctx = await load(row.spaceId, now);
    const result = calling.applyOutcome({ card: row.snapshot, event, actor: toCoreActor(actor), now, settings: ctx.settings, calendar: ctx.calendar });
    if (result.status === 'applied' || result.status === 'fact_only') await persistTransition(tx, actor, { ctx, before: row, result, at: now });
    return result;
  },
});

/** Порт с настройками из активной ревизии: его подключает booking/deps.ts. */
export const cardBookingPort: CardPort = createCardBookingPort(loadCallingContext);
