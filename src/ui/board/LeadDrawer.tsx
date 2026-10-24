'use client';

// Шторка лида (pipeline-v2 §9.6, ui-polish §9.7): нажали на плитку — сверху «Следующий шаг», явка, ссылка на историю,
// ниже поля (плитки, затем карточки; после шести «Ещё N полей» раскрывает на месте), в подвале действия: «Позвонить»
// (тот же путь и та же блокировка, что на плитке), WhatsApp (только мобильный), «Перенести в…» и «Открыть карточку».
// Значение поля — кнопка, правится на месте (CardFieldRow). Данные читаются при открытии и нигде не хранятся.
// Превью ленты (FeedPreview, контракт К2) появится после влития линии card; до тех пор — ссылка «Вся история».
import { Check, MessageCircle, Phone } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { CardFieldRow } from '@/ui/call/CardFieldRow';
import { dialAction } from '@/ui/call/dial';
import { useChannelModes } from '@/ui/channels';
import { chatAction } from '@/ui/messenger/openChat';
import { Badge, BottomSheet, Button, TextLink } from '@/ui/kit';
import { AttendToggle } from './AttendToggle';
import { attendControls, type AttendKind } from './attend';
import { drawerRows, splitRows, type DrawerRow } from './drawerFields';
import { useCardTexts } from './useCardTexts';
import type { BoardCardDto, BoardConfig } from './types';

/** Ссылка на карточку клиента с возвратом на доску (контракт К3): `from` — закрытый список, `tab` — ключ колонки. */
export function cardHref(card: Pick<BoardCardDto, 'clientId' | 'column'>, scope: BoardConfig['scope']): string {
  const base = `/clients/${encodeURIComponent(card.clientId)}`;
  const tab = card.column !== null && /^[a-z0-9_]{1,32}$/.test(card.column) ? card.column : null;
  const q = new URLSearchParams({ from: scope === 'own' ? 'board' : 'deals', ...(tab ? { tab } : {}) });
  return `${base}?${q.toString()}`;
}

export function LeadDrawer({
  card,
  config,
  inlineEdit,
  columnTitle,
  fetchFn,
  onClose,
  now,
  attendBusy,
  onAttend,
  locked,
  callBlocked,
  canMenu,
  onCall,
  onMove,
  onChatOpened,
}: {
  card: BoardCardDto;
  config: Pick<BoardConfig, 'call' | 'scope' | 'canMove' | 'canAttend' | 'eventBehaviors' | 'attendLabels' | 'reasonLabels' | 'eventLabels'>;
  inlineEdit: boolean;
  columnTitle: string;
  fetchFn: typeof fetch;
  onClose: () => void;
  now: number;
  attendBusy: boolean;
  onAttend: (card: BoardCardDto, kind: AttendKind) => void;
  /** Итог по карточке ждёт в очереди устройства. */
  locked: boolean;
  /** На устройстве висит намерение звонка другой карточки. */
  callBlocked: boolean;
  /** Есть куда переносить. */
  canMenu: boolean;
  onCall: (card: BoardCardDto) => void;
  onMove: (card: BoardCardDto) => void;
  onChatOpened: (card: BoardCardDto) => void;
}) {
  const t = useTranslations('board');
  const modes = useChannelModes();
  const texts = useCardTexts(card, config, now);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [rows, setRows] = useState<DrawerRow[]>([]);
  const [saved, setSaved] = useState<Record<string, unknown>>({});
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const ctl = new AbortController();
    void (async () => {
      try {
        const res = await fetchFn(`/api/clients/${encodeURIComponent(card.clientId)}`, { cache: 'no-store', credentials: 'same-origin', signal: ctl.signal });
        if (!res.ok) return setPhase('error');
        setRows(drawerRows(await res.json(), inlineEdit));
        setPhase('ready');
      } catch {
        if (!ctl.signal.aborted) setPhase('error');
      }
    })();
    return () => ctl.abort();
  }, [card.clientId, inlineEdit, fetchFn]);

  const href = cardHref(card, config.scope);
  const controls = attendControls(card, config, now);
  const hint = controls.filter((c) => c.mode === 'toggle').map((c) => c.view).find((v) => !v.interactive && v.hint !== null && v.hint !== 'done');
  const canCall = config.scope === 'own' && config.canMove && card.phone !== null;
  const digits = card.phone?.digits ?? '';
  const dial = (() => {
    if (!canCall || digits === '') return null;
    // Заблокированная карточка: ссылку убираем, остаётся неактивная кнопка (у ссылки нет disabled)
    if (locked || callBlocked) return {};
    const a = dialAction(digits, modes);
    return a.kind === 'tel' ? { href: a.href, external: true as const } : {};
  })();
  const chat = canCall && digits !== '' && card.phone?.kind === 'mobile' ? chatAction(digits, '', modes) : null;
  const hasStep = texts.chipText !== '' || texts.dueText !== '';
  const { first, rest } = splitRows(rows);
  const shown = expanded ? rows : first;
  const secondary = (
    <div className="flex gap-2">
      {canMenu && (
        <Button variant="secondary" block disabled={locked} onClick={() => onMove(card)} data-testid="drawer-move">
          {t('drawer.move')}
        </Button>
      )}
      <Button href={href} variant={dial ? 'secondary' : 'primary'} block data-testid="drawer-open-card">
        {t('drawer.openCard')}
      </Button>
    </div>
  );

  return (
    <BottomSheet
      open
      onClose={onClose}
      closeLabel={t('sheet.close')}
      title={card.name}
      description={[columnTitle, config.scope === 'own' && card.lprName !== '' ? t('lpr', { name: card.lprName }) : '', card.phone?.masked ?? ''].filter((x) => x !== '').join(' · ')}
      footer={
        <div className="flex flex-col gap-2" data-testid="drawer-actions">
          {dial && (
            <div className="flex items-center gap-2">
              <Button
                {...dial}
                variant="success"
                size="lg"
                className="min-w-0 flex-1"
                {...(locked || callBlocked ? { disabled: true } : {})}
                aria-label={t('call.aria', { name: card.name })}
                onClick={() => onCall(card)}
                data-testid="drawer-call"
              >
                <Phone aria-hidden="true" />
                <span>{t('call.button')}</span>
              </Button>
              {chat &&
                (chat.kind === 'link' ? (
                  <Button href={chat.href} external target="_blank" rel="noopener noreferrer" variant="secondary" size="lg" iconOnly aria-label={t('whatsapp.aria', { name: card.name })} onClick={() => onChatOpened(card)} data-testid="drawer-whatsapp">
                    <MessageCircle aria-hidden="true" />
                  </Button>
                ) : (
                  <Button href={`/clients/${card.clientId}`} variant="secondary" size="lg" iconOnly aria-label={t('whatsapp.aria', { name: card.name })} data-testid="drawer-whatsapp">
                    <MessageCircle aria-hidden="true" />
                  </Button>
                ))}
            </div>
          )}
          {secondary}
        </div>
      }
    >
      <div className="flex flex-col gap-4" data-testid="lead-drawer">
        <section className="flex flex-col gap-1" aria-label={t('drawer.nextStep')} data-testid="drawer-next-step">
          <h3 className="text-sm font-semibold">{t('drawer.nextStep')}</h3>
          {hasStep ? (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              {texts.chipText !== '' && <Badge tone={texts.chipTone}>{texts.chipText}</Badge>}
              {texts.dueText !== '' && (
                <span className="font-medium" style={{ color: texts.overdue ? 'var(--danger)' : 'var(--text-2)' }}>
                  {texts.dueText}
                </span>
              )}
            </p>
          ) : (
            <p className="text-sm" style={{ color: 'var(--text-2)' }}>
              {t('drawer.noNextStep')}
            </p>
          )}
        </section>

        {/* Явка: переключатель у того, кто вправе отмечать, значок у остальных, нет записи и признака — ничего (§9.5) */}
        {controls.length > 0 && (
          <div className="flex flex-col gap-1" data-testid="drawer-toggles">
            <div className="flex flex-wrap items-center gap-2">
              {controls.map((c) =>
                c.mode === 'toggle' ? (
                  <AttendToggle key={c.kind} view={c.view} event={config.attendLabels[c.kind]} busy={attendBusy} onToggle={() => onAttend(card, c.kind)} />
                ) : (
                  <Badge key={c.kind} tone="success" icon={<Check aria-hidden="true" />} data-testid={`drawer-badge-${c.kind}`}>
                    {t(`badge.${c.kind}`, { event: config.attendLabels[c.kind] || t('chip.eventUnknown') })}
                  </Badge>
                ),
              )}
            </div>
            {hint?.hint && (
              <p className="text-xs" style={{ color: 'var(--text-3)' }} data-testid="drawer-toggle-hint">
                {t(`toggle.hint.${hint.hint}`, { event: config.attendLabels[hint.kind] || t('chip.eventUnknown') })}
              </p>
            )}
          </div>
        )}

        {/* Вся лента — на карточке клиента */}
        <TextLink href={href} data-testid="drawer-history">
          {t('drawer.history')}
        </TextLink>

        {phase === 'loading' && (
          <p role="status" style={{ color: 'var(--text-2)' }}>
            {t('drawer.loading')}
          </p>
        )}
        {phase === 'error' && (
          <p role="alert" style={{ color: 'var(--danger)' }}>
            {t('drawer.error')}
          </p>
        )}
        {phase === 'ready' && rows.length === 0 && <p style={{ color: 'var(--text-2)' }}>{t('drawer.noFields')}</p>}
        {phase === 'ready' && rows.length > 0 && (
          <div className="flex flex-col gap-2">
            <dl className="text-sm" data-testid="drawer-fields">
              {shown.map(({ field, value }) => (
                <CardFieldRow
                  fetchFn={fetchFn}
                  key={`${field.object}-${field.key}`}
                  field={field}
                  value={Object.hasOwn(saved, `${field.object}-${field.key}`) ? saved[`${field.object}-${field.key}`] : value}
                  cardId={card.id}
                  clientId={card.clientId}
                  onValue={(key, v) => setSaved((s) => ({ ...s, [`${field.object}-${key}`]: v }))}
                />
              ))}
            </dl>
            {rest.length > 0 && (
              <Button variant="quiet" flush onClick={() => setExpanded((x) => !x)} aria-expanded={expanded} data-testid="drawer-more-fields">
                {expanded ? t('drawer.fewerFields') : t('drawer.moreFields', { n: rest.length })}
              </Button>
            )}
          </div>
        )}
      </div>
    </BottomSheet>
  );
}
