import { getTranslations } from 'next-intl/server';
import { Stat, StatGrid } from '@/ui/kit';
import type { CardHeadDto } from '@/server/domain/clients';
import { formatDateTime } from './format';

/** Счётчики с карточки (PROCESS 9.2), без пересчёта: звонки, недозвоны, дозвоны, последний контакт. */
export async function Counters({ head, timeZone }: { head: CardHeadDto; timeZone: string }) {
  const t = await getTranslations('clients');
  const c = head.counters;
  return (
    <StatGrid variant="strip" className="k-statgrid--wrap2" aria-label={t('counters.label')}>
      <Stat value={c.callsTotal} label={t('counters.calls')} />
      <Stat value={c.noAnswerTotal} label={t('counters.noAnswer')} />
      <Stat value={c.connectsTotal} label={t('counters.connects')} />
      <Stat
        value={c.lastConnectAt !== null ? formatDateTime(c.lastConnectAt, timeZone) : t('counters.never')}
        label={t('counters.lastConnect')}
      />
    </StatGrid>
  );
}
