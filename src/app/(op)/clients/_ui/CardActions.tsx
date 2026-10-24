import { getTranslations } from 'next-intl/server';
import { CalendarPlus, ShoppingCart } from 'lucide-react';
import type { Viewer } from '@/server/access';
import { closeReasonOptions, reopenRecipients } from '@/server/domain/cards';
import type { ClientCardDto } from '@/server/domain/clients';
import { Button } from '@/ui/kit';
import { CardMenu } from './CardMenu';
import { TransferButton } from './TransferButton';

type Props = { card: ClientCardDto; viewer: Viewer };

/**
 * Действия карточки по `can.*` с сервера (интерфейс только показывает): «Записать» → мастер записи и пункты меню
 * C9 (закрытие, возврат в обзвон, снятие «Не звонить») и «Передать…» (B9a). Задачи — в своей панели.
 */
export async function CardActions({ card, viewer }: Props) {
  const t = await getTranslations('clients');
  const head = card.card;
  if (!head) return null;
  const can = card.can;
  const menu = can.closeFromMenu || can.reopen || can.unblock;
  if (!can.book && !can.purchase && !menu && !can.transfer) return null;
  const reasons = menu ? await closeReasonOptions(viewer) : { not_target: [], do_not_call: [] };
  const recipients = can.reopen ? await reopenRecipients(viewer) : [];
  return (
    <div className="flex flex-col gap-2">
      {(can.book || can.purchase) && (
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('actions.title')}>
          {can.book && (
            <Button href={`/bookings/new/${head.id}`} variant="secondary" block className="sm:w-auto">
              <CalendarPlus aria-hidden="true" />
              {t('actions.book')}
            </Button>
          )}
          {can.purchase && (
            <Button href={`/deals/purchase/${encodeURIComponent(head.id)}`} variant="secondary" block className="sm:w-auto" data-testid="card-purchase">
              <ShoppingCart aria-hidden="true" />
              {t('actions.purchase')}
            </Button>
          )}
        </div>
      )}
      {can.transfer && (
        <div>
          <TransferButton cardId={head.id} version={head.version} ownerUserId={head.ownerUserId} />
        </div>
      )}
      {menu && (
        <CardMenu
          cardId={head.id}
          version={head.version}
          can={{ closeFromMenu: can.closeFromMenu, reopen: can.reopen, unblock: can.unblock }}
          phones={card.phones.filter((p) => p.working).map((p) => ({ id: p.id, e164: p.e164, primary: p.primary }))}
          reasons={reasons}
          recipients={recipients}
        />
      )}
    </div>
  );
}
