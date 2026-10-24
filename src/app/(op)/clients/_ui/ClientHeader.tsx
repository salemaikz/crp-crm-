import { getTranslations } from 'next-intl/server';
import { Fragment, type ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Badge, Button, PageHeader } from '@/ui/kit';
import type { CardHeadDto, ClientCardDto } from '@/server/domain/clients';
import type { BackTarget } from './backTarget';
import { formatDateTime, formatDue, formatPhone, labelOf } from './format';
import { stateTone } from './stateTone';
import type { LegalFormOption } from './types';

type Props = { card: ClientCardDto; legalForms: LegalFormOption[]; timeZone: string; back?: BackTarget };

/** Шапка карточки: «назад», название с состоянием, строка меты (форма, ЛПР, номер, перезвон, ответственный). */
export async function ClientHeader({ card, legalForms, timeZone, back = { href: '/clients', kind: 'list' } }: Props) {
  const t = await getTranslations('clients');
  const head: CardHeadDto | null = card.card;
  const legal = legalForms.find((f) => f.key === card.legalForm);
  const sub = [legal ? labelOf(legal.label) : '', card.orgId ? t('header.orgId', { id: card.orgId }) : ''].filter(Boolean).join(' · ');
  // Строка меты под заголовком: форма · БИН · ЛПР · номер · перезвон · ответственный (номер не переносится)
  const parts: ReactNode[] = [];
  if (sub) parts.push(sub);
  if (card.decisionMaker) parts.push(`${t('header.decisionMaker')}: ${card.decisionMaker.name}`);
  if (card.primaryPhone) parts.push(<span className="k-num">{formatPhone(card.primaryPhone.e164)}</span>);
  if (head?.nextCallAt != null) {
    // Срок «на день» (воронка v2): только дата и «в течение дня»; без доски шапка прежняя
    const day = head.board !== null && head.nextCallPrecision === 'day';
    parts.push(t('header.callback', { date: day ? t('header.callbackDay', { date: formatDue(head.nextCallAt, 'day', timeZone) }) : formatDateTime(head.nextCallAt, timeZone) }));
  }
  if (head && (head.ownerName || head.actingName)) {
    parts.push(`${head.ownerName ? t('header.owner', { name: head.ownerName }) : t('header.pool')}${head.actingName ? ` · ${t('header.acting', { name: head.actingName })}` : ''}`);
  }
  const board = head?.board ?? null;
  // Чип причины перезвона: «Подумает · касание 2»; подписи нет в справочнике — чипа нет, сырой ключ не показываем
  const reasonChip =
    board && head?.state === 'callback' && board.callbackReasonLabel
      ? board.callbackTouches > 0
        ? t('header.reasonTouch', { reason: board.callbackReasonLabel, n: board.callbackTouches })
        : board.callbackReasonLabel
      : null;
  // Полоса тона слева (board.tones); цвет не единственный носитель смысла: рядом значки и подписи
  const stripe = board?.tone && board.tone !== 'neutral' ? `var(--${board.tone})` : null;
  const header = (
    <PageHeader
      back={
        <Button href={back.href} variant="quiet" size="sm" flush className="self-start">
          <ArrowLeft aria-hidden="true" />
          {t(back.kind === 'board' ? 'card.backBoard' : 'card.back')}
        </Button>
      }
      title={<span className="break-words">{card.name}</span>}
      meta={
        head ? (
          <>
            <Badge tone={stateTone(head.state)} data-testid="head-state">
              {board?.columnLabel ?? t(`states.${head.state}`)}
            </Badge>
            {head.holdReason && <Badge tone="warning">{t(`hold.${head.holdReason}`)}</Badge>}
            {reasonChip && <Badge tone="neutral" data-testid="head-reason">{reasonChip}</Badge>}
            {board?.attended.group !== null && board?.attended.group !== undefined && (
              <Badge tone="success" data-testid="head-attended-group">
                {board.attended.group ? t('header.attended', { event: board.attended.group }) : t('header.attendedAny')}
              </Badge>
            )}
            {board?.attended.individual !== null && board?.attended.individual !== undefined && (
              <Badge tone="success" data-testid="head-attended-individual">
                {board.attended.individual ? t('header.attended', { event: board.attended.individual }) : t('header.attendedAny')}
              </Badge>
            )}
            {board?.noShow && <Badge tone="danger" data-testid="head-no-show">{t('header.noShow')}</Badge>}
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
  if (stripe === null) return header;
  return (
    <div className="border-l-4 pl-3" style={{ borderLeftColor: stripe }} data-testid="head-tone" data-tone={board?.tone ?? undefined}>
      {header}
    </div>
  );
}
