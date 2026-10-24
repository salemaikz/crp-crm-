'use client';

// Срок перезвона воронки v2 (pipeline-v2 §4.2): подсказка «N-е касание · через X дней — дата», чипы «Завтра»,
// «Через неделю», «Другая дата» и переключатель «Указать время». Без времени срок — «в течение дня»
// (точность «день»), с временем — «время». Выбор живёт в черновике шторки: момент и точность.
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Checkbox, Chip, ChipGroup, Field, Input, Select } from '@/ui/kit';
import { SLOT_STEP_MIN, slotLabel, timeSlots } from './callbackSlots';
import { dueFor, quickDay, scheduleHint } from './callbackPlan';
import type { CallConfig, SheetDraft } from './types';
import { fromLocal, localDay, partsOf } from './zoned';

type Props = {
  config: CallConfig;
  draft: SheetDraft;
  /** Перезвонов по карточке уже было; следующее касание — на единицу больше. */
  touches?: number | undefined;
  /** Момент открытия шторки: от него считаются «Завтра» и подсказка. */
  openedAt: number;
  onChange: (patch: Partial<SheetDraft>) => void;
};

type Pick = 'hint' | 'tomorrow' | 'week' | 'other' | null;

const pad = (n: number) => String(n).padStart(2, '0');

export function CallbackPicker({ config, draft, touches, openedAt, onChange }: Props) {
  const t = useTranslations('call');
  const f = useFormatter();
  const tz = config.timeZone;
  const cal = config.calendar;
  const hint = config.callbackSchedule && touches !== undefined ? scheduleHint({ steps: config.callbackSchedule, touches, now: openedAt, tz, cal }) : null;
  const tomorrow = quickDay('tomorrow', openedAt, tz, cal);
  const week = quickDay('week', openedAt, tz, cal);

  const precision = draft.callbackPrecision ?? 'time';
  const withTime = precision === 'time' && draft.callbackAt !== null;
  const dayOf = draft.callbackAt === null ? null : localDay(draft.callbackAt, tz);
  const timeOf = (() => {
    if (draft.callbackAt === null) return config.callWindowStart;
    const p = partsOf(draft.callbackAt, tz);
    return `${pad(p.h)}:${pad(p.mi)}`;
  })();

  // Какая из кнопок выбрана — по дню, а не по нажатию: шторка пережила перезапуск, а выбор остался в черновике
  const [other, setOther] = useState(false);
  const picked: Pick = other
    ? 'other'
    : dayOf === null
      ? null
      : hint && dayOf === hint.day
        ? 'hint'
        : dayOf === tomorrow
          ? 'tomorrow'
          : dayOf === week
            ? 'week'
            : 'other';

  const setDue = (day: string, time: string | null) => {
    const due = dueFor(day, time, config.callWindowStart, tz);
    onChange({ callbackAt: due.at, callbackPrecision: due.precision });
  };
  const dateText = (day: string) => f.dateTime(fromLocal(day, '12:00', tz), { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: tz });

  return (
    <div className="flex flex-col gap-2" data-testid="callback-picker">
      <ChipGroup label={t('sheet.callbackAt')} showLabel className="flex-wrap">
        {hint && (
          <Chip
            active={picked === 'hint'}
            onClick={() => {
              setOther(false);
              setDue(hint.day, hint.time);
            }}
            aria-label={t('sheet.callback.hintAria')}
            data-testid="callback-hint"
          >
            {t('sheet.callback.hint', { n: hint.touch, days: hint.days, date: dateText(hint.day) })}
          </Chip>
        )}
        <Chip
          active={picked === 'tomorrow'}
          onClick={() => {
            setOther(false);
            setDue(tomorrow, withTime ? timeOf : null);
          }}
          data-testid="callback-tomorrow"
        >
          {t('sheet.callback.tomorrow')}
        </Chip>
        <Chip
          active={picked === 'week'}
          onClick={() => {
            setOther(false);
            setDue(week, withTime ? timeOf : null);
          }}
          data-testid="callback-week"
        >
          {t('sheet.callback.week')}
        </Chip>
        <Chip active={picked === 'other'} onClick={() => setOther(true)} data-testid="callback-other">
          {t('sheet.callback.otherDate')}
        </Chip>
      </ChipGroup>
      {picked === 'other' && (
        <Field label={t('sheet.callback.dateLabel')}>
          <Input
            type="date"
            min={localDay(openedAt, tz)}
            value={dayOf ?? ''}
            onChange={(e) => (e.target.value ? setDue(e.target.value, withTime ? timeOf : null) : onChange({ callbackAt: null }))}
            data-testid="callback-date"
          />
        </Field>
      )}
      <Checkbox
        label={t('sheet.callback.withTime')}
        checked={withTime}
        disabled={dayOf === null}
        onChange={(e) => {
          if (dayOf !== null) setDue(dayOf, e.target.checked ? config.callWindowStart : null);
        }}
        data-testid="callback-with-time"
      />
      {withTime && (
        <Field label={t('sheet.callback.timeLabel')}>
          {/* Список слотов в окне звонков, 24 часа: нативное поле времени показывает «09:00 AM» по системной локали */}
          <Select
            value={timeOf}
            onChange={(e) => {
              if (dayOf !== null) setDue(dayOf, e.target.value);
            }}
            data-testid="callback-time"
          >
            {timeSlots(config.callWindowStart, config.callWindowEnd ?? '23:45', SLOT_STEP_MIN, timeOf).map((slot) => (
              <option key={slot} value={slot}>
                {slotLabel(slot)}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {draft.callbackAt !== null && dayOf !== null && (
        <p className="text-sm" style={{ color: 'var(--text-2)' }} data-testid="callback-chosen">
          {t('sheet.callback.chosen', { date: dateText(dayOf), time: withTime ? timeOf : t('sheet.callback.anyTime') })}
        </p>
      )}
    </div>
  );
}
