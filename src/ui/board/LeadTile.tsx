'use client';

// Плитка лида (pipeline-v2 §9.3, ui-polish §9.3–9.4), не больше четырёх строк; строка, которой нечего показать, не
// выводится. Телефон: 1) огонёк · название · «⋯»; 2) чип причины или записи и срок; 3) ЛПР · закрытый номер · явка;
// 4) «Позвонить» и WhatsApp. Ноутбук: «Позвонить» — круглая кнопка в первой строке, четвёртой строки нет.
// Конечные колонки («Покупка», «Мусор») — компактные: название и «сумма · дата» или «причина · дата», без кнопок.
// Цвет тона не единственный носитель смысла: у плитки с тоном есть значок и текст признака («✓ Был: …»).
import { CalendarCheck, Check, Ellipsis, Flame, MessageCircle, Phone } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import type { PointerEvent as ReactPointerEvent, TouchEvent as ReactTouchEvent } from 'react';
import { chatAction } from '@/ui/messenger/openChat';
import { useChannelModes } from '@/ui/channels';
import { dialAction } from '@/ui/call/dial';
import { Avatar, Badge, Button, initials } from '@/ui/kit';
import { needsAnswer } from './confirm';
import { AttendToggle } from './AttendToggle';
import { attendControls, type AttendKind } from './attend';
import { isEndRole, isWorkingRole } from './columns';
import { formatKzt } from './money';
import { purchaseAmountLine, serviceLine } from './purchase';
import { closeReasonLabel, contactDot, hasFire, tileBadge, tileRows, tileValues, toneOf } from './tile';
import { toneStyle } from './tileStyle';
import { useCardTexts } from './useCardTexts';
import type { BoardCardDto, BoardConfig, ColumnRole } from './types';

export interface LeadTileProps {
  card: BoardCardDto;
  /** Роль колонки: конечные роли рисуются компактно. */
  role: ColumnRole;
  config: Pick<BoardConfig, 'call' | 'serviceLabels' | 'scope' | 'canMove' | 'canAttend' | 'eventBehaviors' | 'agreedExit' | 'reasonLabels' | 'eventLabels' | 'attendLabels' | 'tileFields' | 'writeOffReasons'>;
  tones: readonly { when: string; tone: string }[];
  now: number;
  /** Отметка явки по тумблеру: запрос уходит из экрана. */
  onAttend: (card: BoardCardDto, kind: AttendKind) => void;
  /** Отметка явки этой плитки отправляется. */
  attendBusy?: boolean;
  /** Итог по карточке ждёт в очереди устройства или в окне «Отменить»: плитка заблокирована. */
  locked: boolean;
  /** Найдена поиском. */
  highlighted?: boolean;
  /** На устройстве висит намерение звонка другой карточки: «Позвонить» погашено, пока итог не внесён. */
  callBlocked?: boolean;
  /** Есть куда переносить («⋯ → Перенести в…»). */
  canMenu: boolean;
  dragging?: boolean;
  onOpen: (card: BoardCardDto) => void;
  onCall: (card: BoardCardDto) => void;
  /** WhatsApp открыт: отметка в ленту (через защищённый запрос доски). */
  onChatOpened: (card: BoardCardDto) => void;
  onMenu: (card: BoardCardDto) => void;
  onPointerDown?: (card: BoardCardDto, e: ReactPointerEvent) => void;
  /** Долгое нажатие на телефоне: начало жеста переноса. */
  onTouchStart?: (card: BoardCardDto, e: ReactTouchEvent) => void;
  /** Клик, которым закончилось перетаскивание, не открывает шторку. */
  consumeClick?: () => boolean;
}

export function LeadTile(p: LeadTileProps) {
  const { card, config } = p;
  const t = useTranslations('board');
  const f = useFormatter();
  const modes = useChannelModes();
  const tone = toneOf(card, p.tones, config.eventBehaviors);
  const end = isEndRole(p.role);
  const canCall = config.scope === 'own' && config.canMove;
  const fire = hasFire(card);
  const digits = card.phone?.digits ?? '';
  const controls = attendControls(card, config, p.now);
  const badge = tileBadge(card, controls, Object.values(config.agreedExit.noShowReasons));
  const toggles = controls.filter((c) => c.mode === 'toggle');
  const closeLabel = (c: BoardCardDto) => closeReasonLabel(c, config.call.outcomes, config.writeOffReasons);
  const ctx = { role: p.role, scope: config.scope, canCall, config, now: p.now, tileFields: config.tileFields, closeLabel };
  const rows = tileRows(card, ctx, 'phone');
  const rowsLaptop = tileRows(card, ctx, 'laptop');

  const { chipText, chipTone, dueText, overdue, shortDate } = useCardTexts(card, config, p.now);
  const values = p.role === 'new' ? tileValues(card, config.tileFields) : [];

  // Конечные колонки. «Покупка»: строка 1 — «услуга · вариант» из настроек, строка 2 — «сумма · дата» (nowrap).
  // «Мусор»: «причина ·» и дата. Дата отдельно: при нехватке места переносится подпись, а не дата
  const endParts = (() => {
    if (p.role === 'client') {
      const pr = card.purchases;
      if (!pr) return { label: '', date: '', sum: '', service: '' };
      return {
        label: '',
        date: pr.lastAt !== null ? shortDate(pr.lastAt) : '',
        sum: pr.lastAmountKzt !== null ? formatKzt(f, pr.lastAmountKzt) : '',
        service: serviceLine(pr.lastServiceType, pr.lastVariant, config.serviceLabels),
      };
    }
    return { label: closeLabel(card), date: card.closedAt !== null ? shortDate(card.closedAt) : '', sum: '', service: '' };
  })();

  const dial = canDial();
  function canDial() {
    if (!canCall || digits === '') return null;
    // Заблокированная плитка: ссылку убираем, остаётся неактивная кнопка (у ссылки нет disabled)
    if (p.locked || p.callBlocked) return {};
    const a = dialAction(digits, modes);
    return a.kind === 'tel' ? { href: a.href, external: true as const } : {};
  }
  // WhatsApp — только для мобильного номера (как на карточке клиента)
  const chat = canCall && digits !== '' && card.phone?.kind === 'mobile' ? chatAction(digits, '', modes) : null;
  // Ряд действий — только у своих карточек в рабочих колонках (new, callback)
  // В «Договорились» кнопка звонка — только у плиток обзвона (D-355)
  const showActions = !end && (isWorkingRole(p.role) || (p.role === 'agreed' && needsAnswer(card))) && canCall && card.phone !== null;

  // У доски пространства вместо ЛПР — ответственный
  const contactText = config.scope === 'own' && card.lprName !== '' ? t('lpr', { name: card.lprName }) : '';
  const owner = card.ownerName;
  // Ноутбук: строка 3 (или 2, если строки сведений нет)
  // «⋯» при кнопке «Позвонить» уходит в строку 3 справа и мельчает: в первой строке остаётся место названию
  const menuLow = p.canMenu && showActions && dial !== null;
  const contactRow = rows.meta ? 'md:row-start-3' : 'md:row-start-2';

  return (
    <article
      className="relative isolate grid min-w-0 grid-cols-[minmax(0,1fr)_auto] content-start gap-x-2 gap-y-1.5 rounded-[var(--radius-card)] p-3 select-none md:grid-cols-[minmax(0,1fr)_auto] md:gap-y-0.5 md:p-2 md:pl-3.5"
      style={{
        ...toneStyle(tone),
        opacity: p.locked ? 0.65 : 1,
        ...(p.highlighted || p.dragging ? { boxShadow: [p.highlighted ? '0 0 0 2px var(--ring)' : '0 0 0 2px var(--brand)', toneStyle(tone).boxShadow].filter(Boolean).join(', ') } : {}),
        cursor: p.canMenu && !p.locked ? 'grab' : undefined,
        // Долгое нажатие не открывает системное меню и не выделяет текст (iOS, Android)
        WebkitTouchCallout: 'none',
        WebkitUserSelect: 'none',
      }}
      aria-busy={p.locked || undefined}
      data-testid="lead-tile"
      data-card-id={card.id}
      data-locked={p.locked ? '1' : undefined}
      data-tone={tone ?? undefined}
      data-rows={rows.count}
      data-rows-laptop={rowsLaptop.count}
      onPointerDown={p.onPointerDown ? (e) => p.onPointerDown!(card, e) : undefined}
      onTouchStart={p.onTouchStart ? (e) => p.onTouchStart!(card, e) : undefined}
    >
      {/* Строка 1: огонёк · название (до двух строк) */}
      <div className="col-start-1 row-start-1 flex min-w-0 items-start gap-2">
        {fire && (
          <span className="mt-0.5 shrink-0" style={{ color: card.fire === 'overdue' ? 'var(--danger)' : 'var(--warning)' }} data-testid="tile-fire">
            <Flame size={18} aria-hidden="true" />
            <span className="sr-only">{card.fire === 'overdue' ? t('fire.overdue') : t('fire.today')}</span>
          </span>
        )}
        <h3 className="min-w-0 flex-1 text-base leading-snug font-semibold break-words" style={{ fontFamily: 'var(--font-display)' }}>
          {/* Растянутая кнопка: вся плитка открывает шторку, кнопки действий лежат над ней */}
          <button
            type="button"
            className="line-clamp-2 text-left after:absolute after:inset-0 after:content-['']"
            onClick={() => {
              if (p.consumeClick?.()) return;
              p.onOpen(card);
            }}
            data-testid="tile-open"
          >
            {card.name}
          </button>
        </h3>
        {/* Доска пространства: ответственный — аватар-инициалы 20 px перед «⋯», полное имя в title и aria-label */}
        {owner !== undefined && (
          <span className="relative z-10 mt-0.5 inline-flex shrink-0" title={t('tile.owner', { name: owner })} role="img" aria-label={t('tile.owner', { name: owner })} data-testid="tile-owner">
            <Avatar name={owner} size="xs" />
          </span>
        )}
      </div>

      {/* «⋯»: на телефоне 44 px, на ноутбуке 32 px; справа в первой строке */}
      {p.canMenu && (
        <Button
          variant="quiet"
          iconOnly
          disabled={p.locked}
          aria-label={t('menu.aria', { name: card.name })}
          onClick={() => p.onMenu(card)}
          className={`relative z-10 col-start-2 row-start-1 -my-3 md:my-0 md:col-start-2 md:self-center ${menuLow ? `${contactRow} md:size-6` : 'md:size-8'} md:min-h-0 md:min-w-0`}
          data-no-drag
          data-testid="tile-menu"
        >
          <Ellipsis aria-hidden="true" />
        </Button>
      )}

      {/* Строка 2 */}
      {rows.meta && (
        <div className="col-span-full flex min-w-0 items-center gap-x-2 text-sm md:row-start-2 md:flex-wrap md:gap-y-0.5" data-testid="tile-meta">
          {end ? (
            p.role === 'client' ? (
              <span className="flex min-w-0 flex-col font-medium" style={{ color: 'var(--text-2)' }} data-testid="tile-end">
                {endParts.service !== '' && (
                  <span className="min-w-0 break-words" data-testid="tile-purchase-service">
                    {endParts.service}
                  </span>
                )}
                <span className="whitespace-nowrap" data-testid="tile-purchase-line">
                  {purchaseAmountLine(endParts.sum, endParts.date)}
                </span>
              </span>
            ) : (
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 font-medium" style={{ color: 'var(--text-2)' }} data-testid="tile-end">
                {/* Подпись переносится; «·» стоит в её конце, а не в начале строки. Дата не режется никогда */}
                {endParts.label !== '' && <span className="min-w-0 break-words" data-testid="tile-end-label">{endParts.date !== '' ? `${endParts.label} ·` : endParts.label}</span>}
                {endParts.date !== '' && <span className="shrink-0 whitespace-nowrap" data-testid="tile-end-date">{endParts.date}</span>}
              </span>
            )
          ) : (
            <>
              {card.confirm && (
                <>
                  <Badge
                    tone={card.confirm.mark === 'confirmed' ? 'success' : 'info'}
                    icon={card.confirm.mark === 'confirmed' ? <></> : <CalendarCheck aria-hidden="true" />}
                    className="shrink-0 md:min-h-6 md:py-0.5"
                    data-testid={`tile-confirm-${card.confirm.mark}`}
                  >
                    {card.confirm.mark === 'confirmed' ? t('confirm.mark.confirmed') : t('confirm.mark.todo')}
                    {card.confirm.mark === 'confirmed' && card.confirm.confirmedBy !== undefined && (
                      <span className="relative z-10" title={t('confirm.by', { name: card.confirm.confirmedBy })} data-testid="tile-confirm-by">
                        {' '}
                        · {initials(card.confirm.confirmedBy)}
                      </span>
                    )}
                  </Badge>
                  {card.confirm.mark === 'tried' && (
                    <span className="font-medium whitespace-nowrap" style={{ color: 'var(--text-2)' }} data-testid="tile-confirm-tries">
                      {t('confirm.mark.tried', { n: card.confirm.tries, time: card.confirm.lastTryAt !== null ? f.dateTime(card.confirm.lastTryAt, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: config.call.timeZone }) : '' })}
                    </span>
                  )}
                </>
              )}
              {chipText !== '' && (
                <Badge tone={chipTone} className="h-auto max-w-full min-w-[4.5rem] shrink whitespace-normal py-1 text-left md:min-h-6 md:py-0.5" data-testid="tile-chip">
                  <span className="min-w-0 break-words">{chipText}</span>
                </Badge>
              )}
              {chipText === '' && values.length > 0 && (
                <span className="min-w-0 truncate" style={{ color: 'var(--text-2)' }} data-testid="tile-values">
                  {values.join(' · ')}
                </span>
              )}
              {dueText !== '' && (
                <span className="max-w-full shrink-0 truncate font-medium whitespace-nowrap" style={{ color: overdue ? 'var(--danger)' : 'var(--text-2)' }} data-testid="tile-due">
                  {dueText}
                </span>
              )}
            </>
          )}
        </div>
      )}

      {/* Строка 3: ЛПР (у доски пространства — ответственный) · закрытый номер · явка */}
      {rows.contact && (
        <div className={`col-span-full flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm ${contactRow} ${menuLow ? 'md:col-span-1' : ''}`} style={{ color: 'var(--text-2)' }} data-testid="tile-contact">
          <span className="flex min-w-0 flex-1 basis-32 flex-wrap items-center gap-x-1.5">
            {contactText !== '' ? <span className="truncate">{contactText}</span> : null}
            {/* «·» — конец блока ЛПР, не начало строки с номером */}
            {contactDot({ hasName: contactText !== '', hasPhone: card.phone !== null }) === 'after-name' && (
              <span className="shrink-0" aria-hidden="true">·</span>
            )}
            {card.phone ? (
              <span className="shrink-0 whitespace-nowrap" data-testid="tile-phone">{card.phone.masked}</span>
            ) : canCall ? (
              <span className="truncate" style={{ color: 'var(--text-3)' }}>
                {t('call.noPhone')}
              </span>
            ) : null}
          </span>
          {toggles.length > 0 && (
            <span className="flex shrink-0 items-center gap-1" data-testid="tile-toggles">
              {toggles.map((c) => (
                <AttendToggle key={c.kind} view={c.view} event={config.attendLabels[c.kind]} {...(owner !== undefined ? { compact: true } : {})} {...(p.attendBusy ? { busy: true } : {})} onToggle={() => p.onAttend(card, c.kind)} />
              ))}
            </span>
          )}
          {badge && (
            <Badge
              tone={badge.id === 'noShow' ? 'danger' : badge.id === 'purchased' ? 'brand' : tone === 'warning' ? 'warning' : 'success'}
              {...(badge.id === 'attended' ? { icon: <Check aria-hidden="true" /> } : {})}
              className="shrink-0"
              data-testid={`tile-badge-${badge.id}`}
            >
              {badge.id === 'attended' ? t('badge.attended', { events: badge.kinds.map((k) => config.attendLabels[k] || t('chip.eventUnknown')).join(' · ') }) : t(`badge.${badge.id}`)}
            </Badge>
          )}
        </div>
      )}

      {/* Строка 4 (телефон): «Позвонить» и WhatsApp. На ноутбуке обёртка исчезает, «Позвонить» — круглая в первой строке */}
      {showActions && (
        <div className="relative z-10 col-span-full flex items-center gap-2 md:contents" data-no-drag>
          {dial ? (
            <Button
              {...dial}
              variant="success"
              size="md"
              className={`relative z-10 min-h-[var(--tap-min)] min-w-0 flex-1 md:col-start-2 md:row-start-1 md:self-center md:size-8 md:min-h-0 md:min-w-0 md:flex-none md:rounded-full md:p-0`}
              {...(p.locked || p.callBlocked ? { disabled: true } : {})}
              aria-label={t('call.aria', { name: card.name })}
              title={t('call.button')}
              onClick={() => p.onCall(card)}
              data-testid="tile-call"
            >
              <Phone aria-hidden="true" />
              <span className="md:sr-only">{t('call.button')}</span>
            </Button>
          ) : null}
          {chat &&
            (chat.kind === 'link' ? (
              <Button
                href={chat.href}
                external
                target="_blank"
                rel="noopener noreferrer"
                variant="secondary"
                iconOnly
                className="md:hidden"
                aria-label={t('whatsapp.aria', { name: card.name })}
                onClick={() => p.onChatOpened(card)}
                data-testid="tile-whatsapp"
              >
                <MessageCircle aria-hidden="true" />
              </Button>
            ) : (
              <Button href={`/clients/${card.clientId}`} variant="secondary" iconOnly className="md:hidden" aria-label={t('whatsapp.aria', { name: card.name })} data-testid="tile-whatsapp">
                <MessageCircle aria-hidden="true" />
              </Button>
            ))}
        </div>
      )}
      {p.locked && (
        <p className="col-span-full text-xs" style={{ color: 'var(--text-3)' }} role="status" data-testid="tile-waiting">
          {t('tile.waiting')}
        </p>
      )}
    </article>
  );
}
