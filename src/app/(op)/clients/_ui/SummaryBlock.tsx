import { getTranslations } from 'next-intl/server';
import { Card } from '@/ui/kit';
import type { CatalogLabels, ClientSummaryDto } from '@/server/domain/clients';
import { formatDate, formatDateTime, formatDay, formatNumber, labelOf } from './format';

type Props = { summary: ClientSummaryDto; catalog: CatalogLabels; timeZone: string };

/**
 * Итоговый отчёт по клиенту (PROCESS 9.3): сервер отдаёт структуру, фразы строятся здесь из локали.
 * Блок в шапке карточки, не редактируется. Пример: «С 28.10 по 12.11: 4 звонка (2 дозвона, 2 недозвона)…».
 */
export async function SummaryBlock({ summary: s, catalog, timeZone }: Props) {
  const t = await getTranslations('clients');
  const name = (m: Record<string, { ru: string; kk?: string }>, key: string) => (m[key] ? labelOf(m[key]) : key);
  const lines: string[] = [];

  if (s.period) {
    lines.push(
      t('summary.calls', {
        from: formatDate(s.period.from, timeZone),
        to: formatDate(s.period.to, timeZone),
        total: s.calls.total,
        connects: s.calls.connects,
        noAnswer: s.calls.noAnswer,
      }),
    );
  } else {
    lines.push(t('summary.noCalls'));
  }
  if (s.lprFoundAt !== null) lines.push(t('summary.lpr', { date: formatDate(s.lprFoundAt, timeZone) }));
  for (const b of s.bookings) {
    lines.push(
      t('summary.booking', {
        type: name(catalog.eventTypes, b.eventTypeKey),
        date: formatDay(b.date),
        time: b.time,
        status: t(`summary.bookingStatus.${b.status}`),
        consultant: b.consultantName ?? '',
      }),
    );
  }
  for (const p of s.purchases) {
    lines.push(t('summary.purchase', { service: name(catalog.serviceTypes, p.serviceTypeKey), amount: formatNumber(p.amountKzt), date: formatDate(p.wonAt, timeZone) }));
  }
  for (const h of s.handoffs) {
    lines.push(t('summary.handoff', { team: name(catalog.teams, h.teamKey), status: t(`summary.handoffStatus.${h.status}`) }));
  }
  lines.push(s.ownerName ? t('summary.owner', { name: s.ownerName }) : t('summary.ownerNone'));
  if (s.actingName) lines.push(t('summary.acting', { name: s.actingName }));
  const next = s.nextStep;
  lines.push(next.at !== null ? t(`summary.next.${next.kind}`, { date: formatDateTime(next.at, timeZone) }) : t(`summary.next.${next.kind === 'task' ? 'taskNoDate' : next.kind}`));

  return (
    <Card as="section" aria-labelledby="client-summary-title">
      <h2 id="client-summary-title" className="mb-2 text-lg font-semibold">
        {t('summary.title')}
      </h2>
      <ul className="flex flex-col gap-1" data-testid="client-summary">
        {lines.map((l, i) => (
          <li key={i} className="break-words">
            {l}
          </li>
        ))}
      </ul>
    </Card>
  );
}
