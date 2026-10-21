'use client';

import { useFormatter, useTranslations } from 'next-intl';
import type { BookingApplyCounts, BookingPreviewSummary } from '../types';
import { Alert, Section, Stat, StatGrid, Table, type TableColumn } from '@/ui/kit';

const TILES = ['client_not_found', 'no_event', 'author_unknown', 'duplicate', 'review', 'errors'] as const;

/** Сводка предпросмотра «Записей»: что будет записано, что перейдёт в «Договорились», группы отчёта, мероприятия. */
export function BookingSummaryView({ s }: { s: BookingPreviewSummary }) {
  const t = useTranslations('import.bookings.summary');
  const tb = useTranslations('import.bookings');
  const f = useFormatter();
  const columns: TableColumn<BookingPreviewSummary['byEvent'][number]>[] = [
    { key: 'date', header: t('columns.date'), primary: true, nowrap: true, cell: (e) => <strong>{f.dateTime(Date.parse(`${e.date}T12:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' })}</strong> },
    { key: 'time', header: t('columns.time'), numeric: true, cell: (e) => e.time },
    { key: 'type', header: t('columns.type'), cell: (e) => e.typeLabel },
    { key: 'create', header: t('columns.create'), numeric: true, cell: (e) => f.number(e.create) },
    { key: 'seats', header: t('columns.seats'), numeric: true, cell: (e) => t('seats', { taken: f.number(e.taken + e.create), capacity: f.number(e.capacity) }) },
  ];
  return (
    <div className="flex flex-col gap-4">
      {s.unmappedAuthors.length > 0 && <Alert tone="warning">{tb('unmapped', { labels: s.unmappedAuthors.join(', ') })}</Alert>}
      <StatGrid>
        <Stat value={f.number(s.counts.byAction.create)} label={t('created')} />
        <Stat value={f.number(s.willAgree)} label={t('willAgree')} />
        <Stat value={f.number(s.clarifyToClose)} label={t('clarifyToClose')} />
        <Stat value={f.number(s.clarifyRemaining)} label={t('clarifyRemaining')} />
      </StatGrid>
      <StatGrid>
        {TILES.map((g) => (
          <Stat key={g} value={f.number(s.counts.byGroup[g])} label={t(`tiles.${g}`)} tone={g === 'errors' && s.counts.byGroup.errors > 0 ? 'danger' : 'default'} />
        ))}
      </StatGrid>
      <Section title={t('byEvent')}>
        <Table columns={columns} rows={[...s.byEvent]} rowKey={(e) => e.eventId} dense empty={<p>{t('noEvents')}</p>} />
      </Section>
    </div>
  );
}

export function BookingCountsView({ w }: { w: BookingApplyCounts }) {
  const t = useTranslations('import.bookings.result');
  const f = useFormatter();
  const items: [keyof BookingApplyCounts, number][] = [
    ['bookingsCreated', w.bookingsCreated],
    ['cardsAgreed', w.cardsAgreed],
    ['ownersAssigned', w.ownersAssigned],
    ['authorChanged', w.authorChanged],
    ['clarifyClosed', w.clarifyClosed],
    ['skipped', w.skipped],
  ];
  return (
    <StatGrid>
      {items.map(([k, v]) => (
        <Stat key={k} value={f.number(v)} label={t(`counts.${k}`)} />
      ))}
    </StatGrid>
  );
}
