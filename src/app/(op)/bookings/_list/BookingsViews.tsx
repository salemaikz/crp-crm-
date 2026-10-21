import { getTranslations } from 'next-intl/server';
import { Segmented } from '@/ui/kit';

/** Виды раздела записи: «Записи / Мероприятия» в шапке обеих страниц, чтобы путь не шёл через адресную строку. */
export async function BookingsViews({ active }: { active: 'list' | 'events' }) {
  const t = await getTranslations('booking.views');
  return (
    <Segmented
      label={t('label')}
      items={[
        { id: 'list', label: t('list'), href: '/bookings', active: active === 'list' },
        { id: 'events', label: t('events'), href: '/bookings/events', active: active === 'events' },
      ]}
    />
  );
}
