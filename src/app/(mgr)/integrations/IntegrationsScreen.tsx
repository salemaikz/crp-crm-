'use client';

import { useTranslations } from 'next-intl';
import { EmptyState, PageHeader } from '@/ui/kit';
import { PluginCard } from './PluginCard';
import type { Owner, PluginView } from './types';
import { WazzupCard } from './WazzupCard';

export function IntegrationsScreen({ plugins, owners, timeZone }: { plugins: PluginView[]; owners: Owner[]; timeZone: string }) {
  const t = useTranslations('integrations');
  return (
    <>
      <PageHeader title={t('title')} lead={t('lead')} />
      {plugins.length === 0 ? (
        <EmptyState framed={false} title={t('empty')} />
      ) : (
        <div className="flex flex-col gap-4">
          {plugins.map((p) => (p.pluginId === 'messenger.wazzup' ? <WazzupCard key={p.pluginId} plugin={p} owners={owners} timeZone={timeZone} /> : <PluginCard key={p.pluginId} plugin={p} />))}
        </div>
      )}
    </>
  );
}
