'use client';

// Один элемент ввода поля по его типу (текст, число, дата, список, флажок …) для правки на месте. Подписи — от
// вызывающего (`label`, `emptyLabel`): компонент не знает ни экрана, ни языка. datetime и user здесь не правятся.
import { Checkbox, Field, Input, Select, Textarea } from '@/ui/kit';
import type { FieldDraft } from './draft';

export interface ControlOption {
  key: string;
  label: string;
}

type Props = {
  type: string;
  label: string;
  value: FieldDraft;
  onChange: (next: FieldDraft) => void;
  options?: readonly ControlOption[];
  /** Подпись пустого варианта списка. */
  emptyLabel: string;
  error?: string | undefined;
  name: string;
  autoFocus?: boolean;
};

export function FieldControl({ type, label, value, onChange, options = [], emptyLabel, error, name, autoFocus }: Props) {
  const common = { name, id: `f-${name}`, ...(autoFocus ? { autoFocus: true } : {}) };
  if (type === 'boolean') {
    return <Checkbox {...common} label={label} checked={value === true} error={error} onChange={(e) => onChange(e.target.checked)} />;
  }
  if (type === 'multiselect') {
    const chosen = Array.isArray(value) ? value : [];
    return (
      <fieldset className="flex flex-col gap-2">
        <legend className="k-field__label">{label}</legend>
        {options.map((o) => (
          <Checkbox
            key={o.key}
            name={`${name}-${o.key}`}
            label={o.label}
            checked={chosen.includes(o.key)}
            onChange={(e) => onChange(e.target.checked ? [...chosen, o.key] : chosen.filter((k) => k !== o.key))}
          />
        ))}
        {error && <p className="k-field__error">{error}</p>}
      </fieldset>
    );
  }
  const str = typeof value === 'string' ? value : '';
  if (type === 'select') {
    return (
      <Field label={label} error={error}>
        <Select {...common} value={str} onChange={(e) => onChange(e.target.value)}>
          <option value="">{emptyLabel}</option>
          {options.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </Select>
      </Field>
    );
  }
  if (type === 'textarea') {
    return (
      <Field label={label} error={error}>
        <Textarea {...common} rows={3} value={str} onChange={(e) => onChange(e.target.value)} />
      </Field>
    );
  }
  const inputType = type === 'email' ? 'email' : type === 'url' ? 'url' : type === 'date' ? 'date' : type === 'phone' ? 'tel' : 'text';
  const inputMode = type === 'number' || type === 'money' ? 'decimal' : undefined;
  return (
    <Field label={label} error={error}>
      <Input {...common} type={inputType} inputMode={inputMode} value={str} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}
