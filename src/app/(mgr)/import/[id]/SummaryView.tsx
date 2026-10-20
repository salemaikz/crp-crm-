'use client';

import { useFormatter, useTranslations } from 'next-intl';
import type { ApplyCounts, PreviewSummary } from '../types';
import { Alert, Stat, Table, type TableColumn } from '@/ui/kit';

type Tile = { key: string; value: number; tone?: 'danger' };

/** Плитки предпросмотра: сколько новых, дублей, обновится, оставлено как в CRM, задержано, ошибок. */
export function SummaryView({ s }: { s: PreviewSummary }) {
  const t = useTranslations('import.summary');
  const f = useFormatter();
  const c = s.counts;
  const created = c.byAction.create;
  const tiles: Tile[] = [
    { key: 'create', value: created },
    { key: 'merge', value: c.byAction.merge },
    { key: 'duplicateInFile', value: c.byAction.duplicate_in_file },
    { key: 'updateState', value: c.byAction.update_state },
    { key: 'keptInCrm', value: c.byAction.kept_in_crm },
    { key: 'skipSame', value: c.byAction.skip_same },
    { key: 'stopList', value: c.byAction.stop_list },
    { key: 'rejectedRule', value: c.byAction.rejected_rule },
    { key: 'heldRule', value: c.held.rule },
    { key: 'heldDupPair', value: c.held.dup_pair },
    { key: 'heldConflict', value: c.held.import_conflict },
    { key: 'heldNoPhone', value: c.held.no_working_phone },
    { key: 'unowned', value: s.unowned },
    { key: 'needReview', value: c.needReview },
    { key: 'agreedWithoutBooking', value: c.agreedWithoutBooking },
    { key: 'invalid', value: c.byAction.invalid, tone: c.byAction.invalid > 0 ? 'danger' : undefined },
  ];
  const columns: TableColumn<PreviewSummary['perOperator'][number]>[] = [
    { key: 'name', header: t('operator'), primary: true, cell: (o) => <strong>{o.name}</strong> },
    { key: 'count', header: t('cards'), align: 'right', cell: (o) => f.number(o.count) },
  ];
  return (
    <div className="flex flex-col gap-4">
      {s.unmappedSlots.length > 0 && <Alert tone="warning">{t('unmapped', { labels: s.unmappedSlots.join(', ') })}</Alert>}
      {s.ruleOverlaps.length > 0 && (
        <Alert tone="warning" title={t('overlapsTitle')}>
          {s.ruleOverlaps.map((o) => t('overlap', { from: o.from, to: o.to, slots: o.slots.join(' · ') })).join('; ')}
        </Alert>
      )}
      {s.heldWithWorkingOutcome > 0 && <Alert tone="info">{t('heldWorking', { count: s.heldWithWorkingOutcome })}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((x) => (
          <Stat key={x.key} value={f.number(x.value)} label={t(`tiles.${x.key}`)} tone={x.tone ?? 'default'} />
        ))}
      </div>
      <h3 className="text-base font-semibold">{t('perOperator')}</h3>
      <Table columns={columns} rows={[...s.perOperator]} rowKey={(o) => o.userId} dense empty={<p>{t('noOperators')}</p>} />
    </div>
  );
}

export function CountsView({ w }: { w: ApplyCounts }) {
  const t = useTranslations('import.result');
  const f = useFormatter();
  const items: [string, number][] = [
    ['clientsCreated', w.clientsCreated],
    ['clientsMerged', w.clientsMerged],
    ['cardsCreated', w.cardsCreated],
    ['cardsUpdated', w.cardsUpdated],
    ['phonesAdded', w.phonesAdded],
    ['callsCreated', w.callsCreated],
    ['pairsCreated', w.pairsCreated],
    ['tasksCreated', w.tasksCreated],
    ['stopListed', w.stopListed],
    ['keptInCrm', w.keptInCrm],
    ['skipped', w.skipped],
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {items.map(([k, v]) => (
        <Stat key={k} value={f.number(v)} label={t(`counts.${k}`)} />
      ))}
    </div>
  );
}
