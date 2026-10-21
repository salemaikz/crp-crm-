'use client';

import { useTranslations } from 'next-intl';
import type { BookingDetails } from '../types';
import { Field, FormGrid, Select } from '@/ui/kit';

/** Значение выбора: пусто — решения нет, `none` — «автор неизвестен», иначе id сотрудника. */
export const AUTHOR_NONE = '__none';
export type AuthorChoice = Record<string, string>;

type Props = {
  hints: BookingDetails['hints'];
  staff: BookingDetails['staff'];
  value: AuthorChoice;
  onChange: (next: AuthorChoice) => void;
  disabled: boolean;
};

/** Карта «ярлык из таблицы → сотрудник» профиля «Записи» (D-324): подсказка по номеру или ФИО подставлена, решает РОП. */
export function AuthorMapForm({ hints, staff, value, onChange, disabled }: Props) {
  const t = useTranslations('import.bookings.authors');
  if (hints.length === 0) return <p>{t('none')}</p>;
  return (
    <FormGrid>
      {hints.map((h) => (
        <Field key={h.label} width="md" label={h.label} hint={`${t('rows', { count: h.rows })} · ${t(`by.${h.by}`)}`}>
          <Select
            name={`author-${h.label}`}
            value={value[h.label] ?? ''}
            disabled={disabled}
            onChange={(e) => {
              const next = { ...value };
              if (e.target.value) next[h.label] = e.target.value;
              else delete next[h.label];
              onChange(next);
            }}
          >
            <option value="">{t('pick')}</option>
            <option value={AUTHOR_NONE}>{t('unknown')}</option>
            {staff.map((s) => (
              <option key={s.userId} value={s.userId}>
                {s.disabled ? t('disabled', { name: s.name }) : s.name}
              </option>
            ))}
          </Select>
        </Field>
      ))}
    </FormGrid>
  );
}

/** Выбор → тело запроса: «автор неизвестен» уходит как null, нерешённые ярлыки не отправляются. */
export function authorMapOf(choice: AuthorChoice): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [label, v] of Object.entries(choice)) if (v) out[label] = v === AUTHOR_NONE ? null : v;
  return out;
}

/** Начальный выбор: сохранённая карта прошлого предпросмотра, иначе подсказка (по номеру или ФИО), иначе пусто. */
export function initialChoice(d: BookingDetails): AuthorChoice {
  const out: AuthorChoice = {};
  for (const h of d.hints) {
    const saved = d.savedAuthorMap[h.label];
    if (saved === null) out[h.label] = AUTHOR_NONE;
    else if (saved) out[h.label] = saved;
    else if (h.suggestedUserId) out[h.label] = h.suggestedUserId;
  }
  return out;
}
