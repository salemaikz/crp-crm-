import { getTranslations } from 'next-intl/server';
import { CalendarPlus } from 'lucide-react';
import { Button } from '@/ui/kit';
import type { ClientCan } from '@/server/domain/clients';

type Props = { cardId: string | null; can: ClientCan };

/**
 * Действия карточки по `can.*` с сервера (интерфейс только показывает). Сейчас: «Записать» → мастер записи.
 * Пункты задач, закрытия, возврата, снятия «Не звонить» и передачи появятся, когда `can.*` придёт `true`.
 */
export async function CardActions({ cardId, can }: Props) {
  const t = await getTranslations('clients');
  if (!cardId || !can.book) return null;
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label={t('actions.title')}>
      <Button href={`/bookings/new/${cardId}`} variant="secondary" block className="sm:w-auto">
        <CalendarPlus aria-hidden="true" />
        {t('actions.book')}
      </Button>
    </div>
  );
}
