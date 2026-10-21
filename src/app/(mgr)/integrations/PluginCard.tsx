'use client';

import { useTranslations } from 'next-intl';
import { Badge, Card } from '@/ui/kit';
import type { PluginView } from './types';

/** Провайдер без экрана подключения (Beeline ждёт документацию): название и состояние, без кнопок. */
export function PluginCard({ plugin }: { plugin: PluginView }) {
  const t = useTranslations('integrations');
  const name = t.has(`plugins.${plugin.pluginId}`) ? t(`plugins.${plugin.pluginId}`) : plugin.pluginId;
  return (
    <Card as="section">
      <h2 className="text-lg font-semibold">{name}</h2>
      <p className="mt-1 text-[var(--text-2)]">{plugin.pluginId === 'telephony.beeline' ? t('beeline.waiting') : t(`state.${plugin.usability.usable ? 'usable' : plugin.usability.reason}`)}</p>
      <Badge tone={plugin.usability.usable ? 'success' : 'neutral'}>{t(`state.${plugin.usability.usable ? 'usable' : plugin.usability.reason}`)}</Badge>
    </Card>
  );
}
