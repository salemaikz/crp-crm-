'use client';

import { useTranslations } from 'next-intl';
import { Checkbox, Field, Input, Select, Textarea } from '@/ui/kit';
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
  const v = def.value;
  if (def.type === 'boolean') return v === true;
  if (def.type === 'multiselect') return Array.isArray(v) ? v : [];
  if (v === null || Array.isArray(v)) return '';
  return String(v);
}

/** Значение для отправки: пустое → null (очистить), число — строкой (сервер приводит тип). */
export function payloadOf(def: Pick<FieldView, 'type'>, draft: Draft): FieldValue | null {
  if (typeof draft === 'boolean') return draft;
  if (Array.isArray(draft)) return draft.length ? draft : null;
  const s = draft.trim();
  return s === '' ? null : s;
}

type Props = {
  def: FieldView;
  value: Draft;
  onChange: (next: Draft) => void;
  error?: string;
  name: string;
};

export function FieldControl({ def, value, onChange, error, name }: Props) {
  const t = useTranslations('clients');
  const label = labelOf(def.label);
  const common = { name, id: `f-${name}` };

  if (def.type === 'boolean') {
    return <Checkbox {...common} label={label} checked={value === true} error={error} onChange={(e) => onChange(e.target.checked)} />;
  }
  if (def.type === 'multiselect') {
    const chosen = Array.isArray(value) ? value : [];
    return (
      <fieldset className="flex flex-col gap-2">
        <legend className="k-field__label">{label}</legend>
        {def.options.map((o) => (
          <Checkbox
            key={o.key}
            name={`${name}-${o.key}`}
            label={labelOf(o.label)}
            checked={chosen.includes(o.key)}
            disabled={o.archived && !chosen.includes(o.key)}
            onChange={(e) => onChange(e.target.checked ? [...chosen, o.key] : chosen.filter((k) => k !== o.key))}
          />
        ))}
        {error && <p className="k-field__error">{error}</p>}
      </fieldset>
    );
  }
  const str = typeof value === 'string' ? value : '';
  if (def.type === 'select') {
    return (
      <Field label={label} error={error}>
        <Select {...common} value={str} onChange={(e) => onChange(e.target.value)}>
          <option value="">{t('form.notChosen')}</option>
          {def.options.map((o) => (
            <option key={o.key} value={o.key} disabled={o.archived && o.key !== str}>
              {labelOf(o.label)}
            </option>
          ))}
        </Select>
      </Field>
    );
  }
  if (def.type === 'textarea') {
    return (
      <Field label={label} error={error}>
        <Textarea {...common} rows={3} value={str} onChange={(e) => onChange(e.target.value)} />
      </Field>
    );
  }
  const inputType = def.type === 'email' ? 'email' : def.type === 'url' ? 'url' : def.type === 'date' ? 'date' : def.type === 'phone' ? 'tel' : 'text';
  const inputMode = def.type === 'number' || def.type === 'money' ? 'decimal' : undefined;
  return (
    <Field label={label} error={error}>
      <Input {...common} type={inputType} inputMode={inputMode} value={str} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}
