'use client';

import { useTranslations } from 'next-intl';
import { describeEvent, makeContext, type DescribeItem } from './feedLabels';
import { formatDay, formatDue, splitDuration } from './format';
import type { FeedLabels } from './types';

const BOOKING_STATUSES = ['registered', 'confirmed', 'attended', 'no_show', 'cancelled', 'moved'];

/** Подпись события ленты текстом: одна для «Истории» карточки и превью в шторке доски. */
export function useFeedDescribe(labels: FeedLabels, timeZone: string): (item: DescribeItem) => string {
  const t = useTranslations('clients');
  const context = makeContext(labels, {
    yes: t('fields.yes'),
    no: t('fields.no'),
    empty: t('feed.emptyValue'),
    system: (key) => t(key),
    unknownField: t('feed.unknownField'),
    unknownPhone: t('feed.unknownPhone'),
    unknownContact: t('feed.unknownContact'),
    dueLabel: (at, precision) => formatDue(at, precision, timeZone),
    durationLabel: (sec) => {
      const { minutes, seconds } = splitDuration(sec);
      return minutes > 0 ? t('feed.duration', { minutes, seconds }) : t('feed.durationShort', { seconds });
    },
    bookingStatusLabel: (status) => (BOOKING_STATUSES.includes(status) ? t(`summary.bookingStatus.${status}`) : ''),
    dayLabel: formatDay,
  });
  return (item) => {
    const d = describeEvent(item, context);
    return t(d.key, d.values);
  };
}
