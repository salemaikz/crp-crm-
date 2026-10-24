'use client';

// Адаптер формы «Изменить все» к общему вводу полей (src/ui/fields/FieldControl): поле настроек клиента → пропсы
// общего элемента; черновик и тело запроса — по правилам ввода на месте (деньги «150 000», номер с маской).
import { useTranslations } from 'next-intl';
import { FieldControl as SharedControl } from '@/ui/fields/FieldControl';
import { draftFor, payloadFor } from '@/ui/fields/inline';
import { labelOf } from './format';
import type { FieldValue, FieldView } from './types';

/** Типы, которые правятся в форме. datetime и user выбираются другими экранами. */
const FORM_TYPES = new Set(['text', 'textarea', 'email', 'url', 'phone', 'number', 'money', 'date', 'boolean', 'select', 'multiselect']);

export function isFormField(def: FieldView): boolean {
  return def.access === 'edit' && !def.archived && FORM_TYPES.has(def.type);
}

/** Черновик значения в форме: строка, булево или список ключей. */
export type Draft = string | boolean | string[];

export function draftOf(def: FieldView): Draft {
  return draftFor(def.type, def.value);
}

/** Значение для отправки: пустое → null (очистить), число — строкой (сервер приводит тип). Неразбираемое уходит как есть: ответит сервер. */
export function payloadOf(def: Pick<FieldView, 'type'>, draft: Draft): FieldValue | null {
  const p = payloadFor(def.type, draft);
  if (p.ok) return p.value as FieldValue | null;
  return typeof draft === 'string' ? draft.trim() : null;
}

type Props = { def: FieldView; value: Draft; onChange: (next: Draft) => void; error?: string; name: string };

export function FieldControl({ def, value, onChange, error, name }: Props) {
  const t = useTranslations('clients');
  return (
    <SharedControl
      type={def.type}
      label={labelOf(def.label)}
      value={value}
      onChange={onChange}
      options={def.options.map((o) => ({ key: o.key, label: labelOf(o.label), archived: o.archived }))}
      emptyLabel={t('form.notChosen')}
      error={error}
      name={name}
    />
  );
}
