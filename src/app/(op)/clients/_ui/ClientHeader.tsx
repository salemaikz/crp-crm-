import { getTranslations } from 'next-intl/server';
import { Fragment, type ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Badge, Button, PageHeader } from '@/ui/kit';
import type { CardHeadDto, ClientCardDto } from '@/server/domain/clients';
import { formatDateTime, formatPhone, labelOf } from './format';
import { stateTone } from './stateTone';
import type { LegalFormOption } from './types';

type Props = { card: ClientCardDto; legalForms: LegalFormOption[]; timeZone: string };

/** Шапка карточки: «назад», название с состоянием, строка меты (форма, ЛПР, номер, перезвон, ответственный). */
export async function ClientHeader({ card, legalForms, timeZone }: Props) {
  const t = await getTranslations('clients');
  const head: CardHeadDto | null = card.card;
  const legal = legalForms.find((f) => f.key === card.legalForm);
  const sub = [legal ? labelOf(legal.label) : '', card.orgId ? t('header.orgId', { id: card.orgId }) : ''].filter(Boolean).join(' · ');
  // Строка меты под заголовком: форма · БИН · ЛПР · номер · перезвон · ответственный (номер не переносится)
  const parts: ReactNode[] = [];
  if (sub) parts.push(sub);
  if (card.decisionMaker) parts.push(`${t('header.decisionMaker')}: ${card.decisionMaker.name}`);
  if (card.primaryPhone) parts.push(<span className="k-num">{formatPhone(card.primaryPhone.e164)}</span>);
  if (head?.nextCallAt != null) parts.push(t('header.callback', { date: formatDateTime(head.nextCallAt, timeZone) }));
  if (head && (head.ownerName || head.actingName)) {
    parts.push(`${head.ownerName ? t('header.owner', { name: head.ownerName }) : t('header.pool')}${head.actingName ? ` · ${t('header.acting', { name: head.actingName })}` : ''}`);
  }
  return (
    <PageHeader
      back={
        <Button href="/clients" variant="quiet" size="sm" flush className="self-start">
          <ArrowLeft aria-hidden="true" />
          {t('card.back')}
        </Button>
      }
      title={<span className="break-words">{card.name}</span>}
      meta={
        head ? (
          <>
            <Badge tone={stateTone(head.state)}>{t(`states.${head.state}`)}</Badge>
            {head.holdReason && <Badge tone="warning">{t(`hold.${head.holdReason}`)}</Badge>}
          </>
        ) : undefined
      }
      lead={
        parts.length > 0
          ? parts.map((p, i) => (
              <Fragment key={i}>
                {i > 0 ? ' · ' : ''}
                {p}
              </Fragment>
            ))
          : undefined
      }
    />
  );
}
