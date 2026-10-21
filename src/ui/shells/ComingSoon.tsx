// Заглушка раздела, у которого пока нет страницы: «Скоро». Страница-владелец заменяет файл целиком.
import { getTranslations } from 'next-intl/server';
import { EmptyState, Page } from '@/ui/kit';

export async function ComingSoon() {
  const t = await getTranslations('shell.soon');
  return (
    <Page width="form">
      <EmptyState title={t('title')} description={t('lead')} />
    </Page>
  );
}
