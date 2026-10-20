// Заглушка раздела, у которого пока нет страницы: «Скоро». Страница-владелец заменяет файл целиком.
import { getTranslations } from 'next-intl/server';
import { EmptyState } from '@/ui/kit';

export async function ComingSoon() {
  const t = await getTranslations('shell.soon');
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6">
      <EmptyState title={t('title')} description={t('lead')} />
    </main>
  );
}
