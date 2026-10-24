'use client';

// Карточка «Звонить»: компания, ЛПР, попытка, последний итог, поля, номера и действия. Одна главная кнопка —
// большая зелёная «Позвонить» (по режиму телефонии: tel: звонилки или звонок через провайдера); остальное вторично.
import { Phone } from 'lucide-react';
import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { formatKzPhone } from '@/shared/tel';
import { useChannelModes } from '@/ui/channels';
import { ActionBar, Badge, Button, Card, DataList, type BadgeTone } from '@/ui/kit';
import { dialAction } from './dial';
import { fieldText } from './fieldText';
import { CardFieldRow } from './CardFieldRow';
import type { CallConfig, QueueCard, QueuePhone } from './types';

const GROUP_TONE: Record<QueueCard['group'], BadgeTone> = { callbacks: 'warning', retries: 'info', returns: 'neutral', new: 'brand' };

const isBlank = (v: unknown): boolean => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

export function primaryPhone(phones: readonly QueuePhone[]): QueuePhone | null {
  return phones.find((p) => p.isPrimary) ?? phones[0] ?? null;
}

type Props = {
  card: QueueCard;
  config: CallConfig;
  /** По карточке уже есть звонок без итога: показываем «Указать итог». */
  hasPendingCall: boolean;
  /** Пропуск возможен: есть сеть, не исчерпан лимит дня, по карточке нет звонка без итога. */
  canSkip: boolean;
  onCall: (phone: QueuePhone) => void;
  onResume: () => void;
  onSkip: () => void;
};

export function CallCard({ card, config, hasPendingCall, canSkip, onCall, onResume, onSkip }: Props) {
  const t = useTranslations('call');
  const f = useFormatter();
  const when = (ms: number) => f.dateTime(ms, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const modes = useChannelModes();
  // tel: — ссылка звонилки; провайдер (post, O7b) — кнопка без ссылки, звонок начинает onCall
  const dialProps = (p: QueuePhone) => {
    const a = dialAction(p.digits, modes);
    return a.kind === 'tel' ? { href: a.href, external: true } : {};
  };
  const main = primaryPhone(card.phones);
  const others = card.phones.filter((p) => p.id !== main?.id);
  const lastLabel = card.lastOutcomeCode ? (config.outcomes.find((o) => o.key === card.lastOutcomeCode)?.label ?? card.lastOutcomeCode) : '';
  // Правка поля на месте (CALLBACK_V2): сохранённые значения живут здесь, пока открыта эта карточка
  const [saved, setSaved] = useState<{ cardId: string; values: Record<string, unknown> }>({ cardId: card.cardId, values: {} });
  const overrides = saved.cardId === card.cardId ? saved.values : {};
  const valueOf = (key: string): unknown => (Object.hasOwn(overrides, key) ? overrides[key] : card.fields[key]);
  const onValue = (key: string, value: unknown) =>
    setSaved((cur) => ({ cardId: card.cardId, values: { ...(cur.cardId === card.cardId ? cur.values : {}), [key]: value } }));
  const inline = config.callbackV2 && config.cardFields.some((fl) => fl.editable);
  const rows = config.cardFields
    .map((fl) => ({ key: fl.key, label: fl.label, text: fieldText(valueOf(fl.key), fl.options) }))
    .filter((r) => r.text !== '')
    .slice(0, 4);
  // С правкой на месте: сначала заполненные, затем пустые, которые можно «Добавить» (не больше шести строк)
  const editableRows = config.cardFields
    .filter((fl) => fl.editable || fieldText(valueOf(fl.key), fl.options) !== '' || typeof valueOf(fl.key) === 'boolean')
    .sort((a, b) => Number(isBlank(valueOf(a.key))) - Number(isBlank(valueOf(b.key))))
    .slice(0, 6);

  return (
    <section aria-labelledby="call-title" className="flex flex-col gap-3" data-testid="call-card">
      <Card as="article" padding="lg" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={GROUP_TONE[card.group]}>{t(`card.group.${card.group}`)}</Badge>
          <span className="text-sm" style={{ color: 'var(--text-2)' }}>
            {t('card.attempt', { n: card.attempts + 1 })}
          </span>
          {card.skippedToday && <Badge tone="neutral">{t('card.skipped')}</Badge>}
        </div>
        <h1 id="call-title" className="text-xl font-semibold break-words" style={{ fontFamily: 'var(--font-display)' }}>
          {card.name}
        </h1>
        <p className="text-sm" style={{ color: 'var(--text-2)' }}>
          {/* «ЛПР: выяснен» не повторяем, если ниже уже стоит строка с именем ЛПР */}
          {[
            card.lpr === 'yes' ? (card.decisionMaker ? '' : t('card.lprYes')) : card.lpr === 'no' ? t('card.lprNo') : t('card.lprUnknown'),
            card.isTarget === 'yes' ? t('card.target') : '',
          ]
            .filter((x) => x !== '')
            .join(' · ')}
        </p>
        {card.decisionMaker && (
          <p className="text-sm break-words" data-testid="call-lpr">
            {card.decisionMaker.position !== ''
              ? t('card.lprContactPosition', { name: card.decisionMaker.name, position: card.decisionMaker.position })
              : t('card.lprContact', { name: card.decisionMaker.name })}
            {card.decisionMaker.phone ? ` · ${t('card.lprPhone', { phone: formatKzPhone(card.decisionMaker.phone) })}` : ''}
          </p>
        )}
        <p className="text-sm" data-testid="call-last">
          {card.lastOutcomeAt !== null
            ? t('card.last', { label: lastLabel || t('card.lastUnknown'), when: when(card.lastOutcomeAt) })
            : t('card.first')}
          {card.nextCallAt !== null && card.group === 'callbacks' ? ` · ${t('card.callbackAt', { when: when(card.nextCallAt) })}` : ''}
        </p>
        {card.lastNote && (
          <blockquote className="border-l-4 pl-3 text-sm break-words" style={{ borderColor: 'var(--border)', color: 'var(--text-2)' }} data-testid="call-note">
            <span className="block text-xs" style={{ color: 'var(--text-3)' }}>
              {t('card.lastNote')} · {when(card.lastNote.at)}
            </span>
            {card.lastNote.text}
          </blockquote>
        )}
        {inline && editableRows.length > 0 && (
          <dl className="text-sm" data-testid="call-fields">
            {editableRows.map((fl) => (
              <CardFieldRow key={fl.key} field={fl} value={valueOf(fl.key)} cardId={card.cardId} clientId={card.clientId} onValue={onValue} />
            ))}
          </dl>
        )}
        {!inline && rows.length > 0 && (
          <DataList className="text-sm" items={rows.map((r) => ({ key: r.key, label: r.label, value: r.text }))} />
        )}
      </Card>

      <div className="flex flex-col gap-2">
        {main ? (
          <Button
            {...dialProps(main)}
            variant="success"
            size="lg"
            block
            aria-label={t('call.aria', { phone: formatKzPhone(main.digits) })}
            onClick={() => onCall(main)}
            data-testid="call-button"
          >
            <Phone aria-hidden="true" />
            <span>{t('call.button')}</span>
            <span className="font-normal opacity-90">{formatKzPhone(main.digits)}</span>
          </Button>
        ) : (
          <p className="rounded-[var(--radius-card)] p-3 text-sm" style={{ background: 'var(--warning-tint)', color: 'var(--warning)' }}>
            {t('call.noPhone')}
          </p>
        )}
        {others.map((p) => (
          <Button key={p.id} {...dialProps(p)} variant="secondary" block onClick={() => onCall(p)} data-testid="call-second">
            <Phone aria-hidden="true" />
            <span className="k-nowrap">{t('call.second', { phone: formatKzPhone(p.digits) })}</span>
          </Button>
        ))}
        {hasPendingCall && (
          <Button variant="quiet" block onClick={onResume} data-testid="call-resume">
            {t('call.resume')}
          </Button>
        )}
      </div>

      <ActionBar equal>
        <Button variant="quiet" href={`/clients/${card.clientId}`}>
          {t('card.open')}
        </Button>
        <Button variant="quiet" onClick={onSkip} disabled={!canSkip} data-testid="call-skip">
          {t('card.skip')}
        </Button>
      </ActionBar>
    </section>
  );
}
