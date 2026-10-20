import { getTranslations } from 'next-intl/server';
import { Badge } from '@/ui/kit';
import type { CardHeadDto, ClientCardDto } from '@/server/domain/clients';
import { formatDateTime, formatPhone, labelOf } from './format';
import { stateTone } from './stateTone';
import type { LegalFormOption } from './types';

type Props = { card: ClientCardDto; legalForms: LegalFormOption[]; timeZone: string };

/** Шапка карточки: название, форма и БИН, ЛПР, главный номер, состояние и перезвон. */
export async function ClientHeader({ card, legalForms, timeZone }: Props) {
  const t = await getTranslations('clients');
  const head: CardHeadDto | null = card.card;
  const legal = legalForms.find((f) => f.key === card.legalForm);
  const sub = [legal ? labelOf(legal.label) : '', card.orgId ? t('header.orgId', { id: card.orgId }) : ''].filter(Boolean).join(' · ');
  return (
    <header className="flex flex-col gap-2">
      <h1 className="text-2xl font-semibold break-words">{card.name}</h1>
      {sub && <p className="text-sm text-[var(--text-2)]">{sub}</p>}
      {card.decisionMaker && (
        <p>
          <span className="text-[var(--text-2)]">{t('header.decisionMaker')}: </span>
          {card.decisionMaker.name}
        </p>
      )}
      {card.primaryPhone && <p className="text-lg font-medium">{formatPhone(card.primaryPhone.e164)}</p>}
      {head && (
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={stateTone(head.state)}>{t(`states.${head.state}`)}</Badge>
          {head.holdReason && <Badge tone="warning">{t(`hold.${head.holdReason}`)}</Badge>}
          {head.nextCallAt !== null && <span>{t('header.callback', { date: formatDateTime(head.nextCallAt, timeZone) })}</span>}
        </div>
      )}
      {head && (head.ownerName || head.actingName) && (
        <p className="text-sm text-[var(--text-2)]">
          {head.ownerName ? t('header.owner', { name: head.ownerName }) : t('header.pool')}
          {head.actingName ? ` · ${t('header.acting', { name: head.actingName })}` : ''}
        </p>
      )}
    </header>
  );
}
