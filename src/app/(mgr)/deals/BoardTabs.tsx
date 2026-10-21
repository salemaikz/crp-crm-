// Вкладки страницы /deals: «Сделки» и (для РОП) «Обзвон» (B8). Ссылки, поэтому работают и без скриптов.
import { useTranslations } from 'next-intl';
import { Segmented } from '@/ui/kit';

export function BoardTabs({ active, showCalling }: { active: 'deals' | 'calling'; showCalling: boolean }) {
  const t = useTranslations('deals.board');
  if (!showCalling) return null;
  return (
    <Segmented
      label={t('tabs.label')}
      items={[
        { id: 'deals', label: t('tabs.deals'), href: '/deals', active: active === 'deals' },
        { id: 'calling', label: t('tabs.calling'), href: '/deals/calling', active: active === 'calling' },
      ]}
    />
  );
}
