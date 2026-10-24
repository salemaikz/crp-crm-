// Вкладки страницы /deals: «Сделки» и (для РОП) «Обзвон» (B8). Ссылки, поэтому работают и без скриптов.
// При OP_BOARD (К5): «Доска» первой, второй — «Этапы сделок»; вкладки только при включённом KANBAN (решает страница).
import { useTranslations } from 'next-intl';
import { Segmented } from '@/ui/kit';

export function BoardTabs({ active, showCalling, opBoard = false }: { active: 'deals' | 'calling'; showCalling: boolean; opBoard?: boolean }) {
  const t = useTranslations('deals.board');
  if (!showCalling) return null;
  const deals = { id: 'deals', label: t(opBoard ? 'tabs.stages' : 'tabs.deals'), href: '/deals', active: active === 'deals' };
  const calling = { id: 'calling', label: t(opBoard ? 'tabs.board' : 'tabs.calling'), href: '/deals/calling', active: active === 'calling' };
  return <Segmented label={t('tabs.label')} items={opBoard ? [calling, deals] : [deals, calling]} />;
}
