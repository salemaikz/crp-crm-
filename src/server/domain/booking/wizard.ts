// Мастер записи: всё для одного экрана одним чтением (B3a, docs/booking-wizard-design.md §6.2).
// Охват: карточка по `booking.create`; чужая и несуществующая — одинаково NotFoundError.
import { booking } from '@crm/core';
import { NotFoundError, requireAccess, scopeOf } from '@/server/access';
import { BOOKABLE_CARD_STATES } from './bookings';
import { consultDays } from './consult';
import { offerInTx } from './events';
import { requireSpace } from './guards';
import { findWizardCard, listActiveFutureBookings, toBookingView } from './repo';
import { inBookingTx } from './tx';
import type { ConsultOffer, GetBookingWizard, LocalizedLabel, WizardDirection, WizardEventType } from './types';

/** Подпись на языке зрителя: локаль `kz` → `kk ?? ru`, иначе `ru` (D-002). */
export function pickLabel(l: LocalizedLabel, locale: string): string {
  return locale === 'kz' || locale === 'kk' ? (l.kk ?? l.ru) : l.ru;
}

export const getBookingWizard: GetBookingWizard = async (deps, viewer, input) => {
  // Консультант записывает клиента своей консультации к себе (отношение booked_with_me, D-246): право есть и без роли
  requireAccess(viewer, 'booking.create', 'object');
  const byRelationOnly = scopeOf(viewer, 'booking.create') === null;
  const spaceId = requireSpace(viewer);
  const now = deps.now();
  const settings = await deps.settings(spaceId, now);
  const { catalog } = settings;
  return inBookingTx({}, async (tx) => {
    const card = await findWizardCard(viewer, tx, { spaceId, cardId: input.cardId });
    if (!card) throw new NotFoundError();

    // По отношению доступны только консультации: групповые мероприятия ему недоступны (404 на запись)
    const visibleTypes = byRelationOnly ? catalog.eventTypes.filter((t) => t.behavior === 'individual') : catalog.eventTypes;
    const types: WizardEventType[] = visibleTypes.map((t) => ({
      key: t.key,
      behavior: t.behavior,
      label: pickLabel(t.label, input.locale),
      short: pickLabel(t.short, input.locale),
      durationMin: t.durationMin,
    }));

    const groupOffers = [];
    const consultOffers: ConsultOffer[] = [];
    const days = consultDays(settings, now);
    for (const t of visibleTypes) {
      if (t.behavior === 'group') {
        // Вид без ёмкости (`groupTypes`) мероприятий не имеет: предлагать нечего
        if (!settings.groupTypes.some((g) => g.key === t.key)) continue;
        groupOffers.push({ eventTypeKey: t.key, ...(await offerInTx(viewer, tx, { spaceId, clientId: card.clientId, settings, eventTypeKey: t.key, now })) });
        continue;
      }
      const directions: WizardDirection[] = catalog.directions
        .filter((d) => t.directions.length === 0 || t.directions.includes(d.key))
        .map((d) => ({ key: d.key, label: pickLabel(d.label, input.locale) }));
      const active = await listActiveFutureBookings(viewer, tx, { spaceId, clientId: card.clientId, now, perm: 'booking.create', kind: 'individual' });
      const current = active.find((b) => b.eventTypeKey === t.key) ?? null;
      consultOffers.push({ eventTypeKey: t.key, directions, days, current: current ? toBookingView(current) : null });
    }

    return {
      cardId: card.cardId,
      clientId: card.clientId,
      clientName: card.clientName,
      mode: BOOKABLE_CARD_STATES.includes(card.state) ? 'direct' : 'outcome_required',
      types,
      groupOffers,
      consultOffers,
      timeZone: settings.timeZone,
      today: booking.epochToLocalDate(settings.timeZone, now),
    };
  });
};
