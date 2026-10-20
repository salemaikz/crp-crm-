// Вкладки страницы /deals: «Сделки» и (для РОП) «Обзвон» (B8). Ссылки, поэтому работают и без скриптов.
import { useTranslations } from 'next-intl';
import { Chip, ChipGroup } from '@/ui/kit';

export function BoardTabs({ active, showCalling }: { active: 'deals' | 'calling'; showCalling: boolean }) {
  const t = useTranslations('deals.board');
  if (!showCalling) return null;
  return (
    <ChipGroup label={t('tabs.label')}>
      <Chip href="/deals" active={active === 'deals'}>
        {t('tabs.deals')}
      </Chip>
      <Chip href="/deals/calling" active={active === 'calling'}>
        {t('tabs.calling')}
      </Chip>
    </ChipGroup>
  );
}
