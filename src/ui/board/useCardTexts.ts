'use client';

// Подписи плитки и шторки лида из одной карточки: чип причины или записи со статусом, срок словами (ui-polish §9.3).
// Один источник для плитки и «Следующего шага» шторки: расхождения подписей между ними быть не должно.
import { useFormatter, useTranslations } from 'next-intl';
import type { BadgeTone } from '@/ui/kit';
import { chipOf, dueOf, eventStatusKey, overdueParts, reasonLabel } from './tile';
import type { BoardCardDto, BoardConfig } from './types';

/** Тон чипа записи по её статусу: «Подтвердил» — зелёный, «Не пришёл» — красный; «Не подтвердил» на плитке не пишется. */
const STATUS_TONE: Record<string, BadgeTone> = { confirmed: 'success', registered: 'neutral', no_show: 'danger' };

export function useCardTexts(card: BoardCardDto, config: Pick<BoardConfig, 'reasonLabels' | 'eventLabels'>, now: number) {
  const t = useTranslations('board');
  const f = useFormatter();
  const chip = chipOf(card);
  const due = dueOf(card, now);
  const time = (ms: number) => f.dateTime(ms, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const day = (ms: number) => f.dateTime(ms, { weekday: 'short', day: '2-digit', month: '2-digit' });
  const shortDate = (ms: number) => f.dateTime(ms, { day: '2-digit', month: '2-digit' });

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

  // Чип: причина и касание, недозвон, запись со статусом, состояние
  const chipText = (() => {
    if (chip.kind === 'reason') {
      const label = reasonLabel(config.reasonLabels, chip.reason) ?? t('chip.reasonOther');
      return chip.touches > 0 ? t('chip.reasonTouch', { reason: label, n: chip.touches }) : label;
    }
    if (chip.kind === 'attempts') return t('chip.attempts', { n: chip.n });
    if (chip.kind === 'event') {
      const label = config.eventLabels[chip.type] ?? t('chip.eventUnknown');
      const args = { event: label, day: day(chip.startsAt), time: time(chip.startsAt) };
      const status = eventStatusKey(chip.status);
      return status ? t('chip.eventStatus', { status: t(`chip.status.${status}`), ...args }) : t('chip.event', args);
    }
    if (chip.kind === 'state') return t(`state.${chip.state}`);
    return '';
  })();
  const chipTone: BadgeTone = chip.kind === 'event' ? (STATUS_TONE[chip.status] ?? 'neutral') : 'neutral';

  return { chip, due, chipText, chipTone, dueText, overdue: due.kind === 'overdue', shortDate };
}
