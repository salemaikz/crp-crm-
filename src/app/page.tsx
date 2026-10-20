import { getTranslations } from 'next-intl/server';

// Заглушка каркаса: настоящие оболочки (оператор, менеджер) — задачи P9a и дальше.
export default async function HomePage() {
  const t = await getTranslations('common');
  return (
    <main className="mx-auto max-w-xl p-6">
      <h1 className="text-2xl font-semibold">{t('app.name')}</h1>
      <p className="mt-2 text-neutral-600">{t('status.ready')}</p>
    </main>
  );
}
