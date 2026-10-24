'use client';

// Плитка лида (pipeline-v2 §9.3), не больше четырёх строк:
// 1. огонёк · название · значки признаков; 2. чип причины или состояния и срок; 3. ЛПР и закрытый номер;
// 4. «Позвонить» (крупная зелёная), WhatsApp, «⋯». Нажатие вне кнопок открывает шторку лида.
// Цвет тона (§5.3) не единственный носитель смысла: у плитки с тоном есть значок и текст признака.
import { Ellipsis, Flame, MessageCircle, Phone } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import type { CSSProperties, PointerEvent as ReactPointerEvent, TouchEvent as ReactTouchEvent } from 'react';
import { chatAction } from '@/ui/messenger/openChat';
import { useChannelModes } from '@/ui/channels';
import { dialAction } from '@/ui/call/dial';
import { Badge, Button, type BadgeTone } from '@/ui/kit';
import { AttendToggle } from './AttendToggle';
import { toggleViews, type AttendKind } from './attend';
import { badgesOf, chipOf, dueOf, hasFire, overdueParts, reasonLabel, toneOf, type BadgeId, type Tone } from './tile';
import type { BoardCardDto, BoardConfig } from './types';

const BADGE_TONE: Record<BadgeId, BadgeTone> = { attendedGroup: 'success', attendedIndividual: 'warning', purchased: 'brand', noShow: 'danger' };

/** Тон плитки → переменные темы (тёмная тема подменяет их сама). */
function toneStyle(tone: Tone | null): CSSProperties {
  if (!tone) return { background: 'var(--surface)', borderLeftColor: 'var(--border-strong)' };
  if (tone === 'neutral') return { background: 'var(--canvas)', borderLeftColor: 'var(--border-strong)' };
  return { background: `var(--${tone}-tint)`, borderLeftColor: `var(--${tone})` };
}

export interface LeadTileProps {
  card: BoardCardDto;
  tones: readonly { when: string; tone: string }[];
  now: number;
  /** Подписи причин перезвона и видов записи из настроек. */
  reasonLabels: Record<string, string>;
  eventLabels: Record<string, string>;
  attendLabels: { attendedGroup: string; attendedIndividual: string };
  /** Право и виды записи для тумблеров «Был на …». */
  attend: Pick<BoardConfig, 'canAttend' | 'eventBehaviors'>;
  /** Отметка явки по тумблеру: запрос уходит из экрана. */
  onAttend: (card: BoardCardDto, kind: AttendKind) => void;
  /** Отметка явки этой плитки отправляется. */
  attendBusy?: boolean;
  /** Итог по карточке ждёт в очереди устройства или в окне «Отменить»: плитка заблокирована. */
  locked: boolean;
  /** Найдена поиском. */
  highlighted?: boolean;
  /** Звонок с плитки разрешён (свои карточки, есть номер). */
  canCall: boolean;
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
  const { card } = p;
  const t = useTranslations('board');
  const f = useFormatter();
  const modes = useChannelModes();
  const tone = toneOf(card, p.tones);
  // «Был на …» — тумблеры (показ или отметка), остальные признаки — значки
  const badges = badgesOf(card).filter((b) => b !== 'attendedGroup' && b !== 'attendedIndividual');
  const toggles = toggleViews(card, p.attend, p.now);
  const chip = chipOf(card);
  const due = dueOf(card, p.now);
  const fire = hasFire(card);
  const digits = card.phone?.digits ?? '';

  const time = (ms: number) => f.dateTime(ms, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const day = (ms: number) => f.dateTime(ms, { weekday: 'short', day: '2-digit', month: '2-digit' });
  const dueText = (() => {
    if (due.kind === 'none') return '';
    if (due.kind === 'overdue') {
      const o = overdueParts(due.minutes);
      const ago = t(`due.ago.${o.unit}`, { n: o.n });
      // Срок «в течение дня» прошлых суток: говорим датой, а не часами
      return due.precision === 'day' ? t('due.overdueDay', { day: day(due.at) }) : t('due.overdue', { ago });
    }
    if (due.kind === 'today') return due.precision === 'time' ? t('due.todayAt', { time: time(due.at) }) : t('due.todayDay');
    return due.precision === 'time' ? t('due.at', { day: day(due.at), time: time(due.at) }) : t('due.day', { day: day(due.at) });
  })();

  const chipText = (() => {
    if (chip.kind === 'reason') {
      const label = reasonLabel(p.reasonLabels, chip.reason) ?? t('chip.reasonOther');
      return chip.touches > 0 ? t('chip.reasonTouch', { reason: label, n: chip.touches }) : label;
    }
    if (chip.kind === 'attempts') return t('chip.attempts', { n: chip.n });
    if (chip.kind === 'event') {
      const label = p.eventLabels[chip.type] ?? t('chip.eventUnknown');
      return t('chip.event', { event: label, day: day(chip.startsAt), time: time(chip.startsAt) });
    }
    if (chip.kind === 'state') return t(`state.${chip.state}`);
    return '';
  })();

  const dial = canDial();
  function canDial() {
    if (!p.canCall || digits === '') return null;
    // Заблокированная плитка: ссылку убираем, остаётся неактивная кнопка (у ссылки нет disabled)
    if (p.locked || p.callBlocked) return {};
    const a = dialAction(digits, modes);
    return a.kind === 'tel' ? { href: a.href, external: true as const } : {};
  }
  const chat = p.canCall && digits !== '' ? chatAction(digits, '', modes) : null;

  return (
    <article
      className="relative flex min-w-0 flex-col gap-2 rounded-[var(--radius-card)] border border-l-4 p-3 select-none"
      style={{
        borderColor: 'var(--border)',
        ...toneStyle(tone),
        opacity: p.locked ? 0.65 : 1,
        boxShadow: p.highlighted ? '0 0 0 2px var(--ring)' : p.dragging ? '0 0 0 2px var(--brand)' : undefined,
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
      onPointerDown={p.onPointerDown ? (e) => p.onPointerDown!(card, e) : undefined}
      onTouchStart={p.onTouchStart ? (e) => p.onTouchStart!(card, e) : undefined}
    >
      <div className="flex min-w-0 items-start gap-2">
        {fire && (
          <span className="mt-0.5 shrink-0" style={{ color: card.fire === 'overdue' ? 'var(--danger)' : 'var(--warning)' }} data-testid="tile-fire">
            <Flame size={18} aria-hidden="true" />
            <span className="sr-only">{card.fire === 'overdue' ? t('fire.overdue') : t('fire.today')}</span>
          </span>
        )}
        <h3 className="min-w-0 flex-1 text-base font-semibold break-words" style={{ fontFamily: 'var(--font-display)' }}>
          {/* Растянутая кнопка: вся плитка открывает шторку, кнопки действий лежат над ней */}
          <button
            type="button"
            className="text-left after:absolute after:inset-0 after:content-['']"
            onClick={() => {
              if (p.consumeClick?.()) return;
              p.onOpen(card);
            }}
            data-testid="tile-open"
          >
            {card.name}
          </button>
        </h3>
      </div>

      {(toggles.length > 0 || badges.length > 0 || chipText !== '' || dueText !== '') && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {toggles.map((v) => (
            <AttendToggle key={v.kind} view={v} event={p.attendLabels[v.kind]} {...(p.attendBusy ? { busy: true } : {})} onToggle={() => p.onAttend(card, v.kind)} />
          ))}
          {badges.map((b) => (
            <Badge key={b} tone={BADGE_TONE[b]} data-testid={`tile-badge-${b}`}>
              {t(`badge.${b}`, { event: t('chip.eventUnknown') })}
            </Badge>
          ))}
          {chipText !== '' && (
            <Badge tone="neutral" data-testid="tile-chip">
              {chipText}
            </Badge>
          )}
          {dueText !== '' && (
            <span className="text-sm font-medium" style={{ color: due.kind === 'overdue' ? 'var(--danger)' : 'var(--text-2)' }} data-testid="tile-due">
              {dueText}
            </span>
          )}
        </div>
      )}

      {(card.lprName !== '' || card.phone) && (
        <p className="text-sm break-words" style={{ color: 'var(--text-2)' }} data-testid="tile-contact">
          {[card.lprName !== '' ? t('lpr', { name: card.lprName }) : '', card.phone?.masked ?? ''].filter((x) => x !== '').join(' · ')}
        </p>
      )}

      <div className="relative z-10 flex items-center gap-2" data-no-drag>
        {dial ? (
          <Button
            {...dial}
            size="md"
            className="min-w-0 flex-1 bg-success text-on-success"
            {...(p.locked || p.callBlocked ? { disabled: true } : {})}
            aria-label={t('call.aria', { name: card.name })}
            onClick={() => p.onCall(card)}
            data-testid="tile-call"
          >
            <Phone aria-hidden="true" />
            <span>{t('call.button')}</span>
          </Button>
        ) : (
          <span className="min-w-0 flex-1 text-sm" style={{ color: 'var(--text-3)' }}>
            {card.phone ? '' : t('call.noPhone')}
          </span>
        )}
        {chat &&
          (chat.kind === 'link' ? (
            <Button
              href={chat.href}
              external
              target="_blank"
              rel="noopener noreferrer"
              variant="secondary"
              iconOnly
              aria-label={t('whatsapp.aria', { name: card.name })}
              onClick={() => p.onChatOpened(card)}
              data-testid="tile-whatsapp"
            >
              <MessageCircle aria-hidden="true" />
            </Button>
          ) : (
            <Button href={`/clients/${card.clientId}`} variant="secondary" iconOnly aria-label={t('whatsapp.aria', { name: card.name })} data-testid="tile-whatsapp">
              <MessageCircle aria-hidden="true" />
            </Button>
          ))}
        {p.canMenu && (
          <Button variant="quiet" iconOnly disabled={p.locked} aria-label={t('menu.aria', { name: card.name })} onClick={() => p.onMenu(card)} data-testid="tile-menu">
            <Ellipsis aria-hidden="true" />
          </Button>
        )}
      </div>
      {p.locked && (
        <p className="text-xs" style={{ color: 'var(--text-3)' }} role="status" data-testid="tile-waiting">
          {t('tile.waiting')}
        </p>
      )}
    </article>
  );
}
