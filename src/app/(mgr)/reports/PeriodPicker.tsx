'use client';

import { useTranslations } from 'next-intl';
import { Chip, ChipGroup, Field, FilterBar, Input } from '@/ui/kit';
import { PRESETS, periodProblem, presetRange, type Preset } from './dates';

type Props = {
  from: string;
  to: string;
  today: string;
  onChange: (range: { from: string; to: string }) => void;
};

/** Быстрый выбор периода и две даты. Неверный период не отправляется на сервер: показываем подсказку. */
export function PeriodPicker({ from, to, today, onChange }: Props) {
  const t = useTranslations('reports.period');
  const bad = periodProblem(from, to, today);
  const activePreset: Preset | null = PRESETS.find((p) => {
    const r = presetRange(p, today);
    return r.from === from && r.to === to;
  }) ?? null;
  return (
    <div className="flex flex-col gap-3">
      <ChipGroup label={t('quick')}>
        {PRESETS.map((p) => (
          <Chip key={p} active={activePreset === p} onClick={() => onChange(presetRange(p, today))}>
            {t(p)}
          </Chip>
        ))}
        <Chip active={activePreset === null}>{t('custom')}</Chip>
      </ChipGroup>
      <FilterBar>
        <Field label={t('from')} error={bad ? t('invalid') : undefined}>
          <Input type="date" name="from" value={from} max={to} onChange={(e) => onChange({ from: e.target.value, to })} />
        </Field>
        <Field label={t('to')}>
          <Input type="date" name="to" value={to} onChange={(e) => onChange({ from, to: e.target.value })} />
        </Field>
      </FilterBar>
    </div>
  );
}
