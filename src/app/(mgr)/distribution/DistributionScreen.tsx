'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { Alert, Page, PageHeader, Tabs } from '@/ui/kit';
import { JournalPanel } from './JournalPanel';
import { OwnerlessPanel } from './OwnerlessPanel';
import { ParticipantsPanel } from './ParticipantsPanel';
import { PoolPanel } from './PoolPanel';
import { ProposalsPanel } from './ProposalsPanel';
import type { DistributionData } from './types';

export function DistributionScreen({ data }: { data: DistributionData }) {
  const t = useTranslations('distribution');
  const router = useRouter();
  const refresh = () => router.refresh();
  return (
    <Page width="wide">
      <PageHeader title={t('title')} lead={t('lead')} />
      {data.participants.length === 0 && <Alert tone="info">{t('participants.empty.description')}</Alert>}
      <Tabs
        label={t('tabs.label')}
        variant="segmented"
        items={[
          { id: 'pool', label: t('tabs.pool'), count: data.pool.summary.ready, content: <PoolPanel data={data} onChanged={refresh} /> },
          { id: 'participants', label: t('tabs.participants'), count: data.participants.length, content: <ParticipantsPanel data={data} onChanged={refresh} /> },
          { id: 'proposals', label: t('proposals.tab'), count: data.proposals.length, content: <ProposalsPanel data={data} onChanged={refresh} /> },
          { id: 'ownerless', label: t('ownerless.tab'), count: data.pool.summary.ownerless, content: <OwnerlessPanel data={data} onChanged={refresh} /> },
          { id: 'journal', label: t('tabs.journal'), content: <JournalPanel data={data} /> },
        ]}
      />
    </Page>
  );
}
