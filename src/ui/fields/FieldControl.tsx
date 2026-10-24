'use client';

// Единый элемент ввода поля по его типу из пресета (D-356): text, textarea, email, url, number, money, phone, select,
// multiselect, boolean, date. Используется вводом на месте (InlineField), карточкой обзвона и формой «Изменить все».
// Подписи — от вызывающего (`label`, `emptyLabel`): компонент не знает ни экрана, ни языка. datetime и user не правятся.
import type { KeyboardEvent } from 'react';
import { Checkbox, Field, Input, Select, Textarea } from '@/ui/kit';
import type { FieldDraft } from './draft';
import { groupDigits, maskPhone } from './inline';

export interface ControlOption {
  key: string;
  label: string;
  /** Архивный вариант: выбранный остаётся виден, новый выбрать нельзя. */
  archived?: boolean;
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
  /** Подпись только для вспомогательных технологий (ввод на месте: подпись уже стоит рядом). */
  hideLabel?: boolean;
  /** Клавиша «Ввод» на экранной клавиатуре (на месте — «done»). */
  enterKeyHint?: 'done' | 'enter' | 'next' | 'go' | 'search' | 'send';
  onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void;
};

const INPUT_TYPE: Record<string, string> = { email: 'email', url: 'url', date: 'date', phone: 'tel' };

export function FieldControl({ type, label, value, onChange, options = [], emptyLabel, error, name, autoFocus, hideLabel, enterKeyHint, onKeyDown }: Props) {
  const common = {
    name,
    id: `f-${name}`,
    ...(autoFocus ? { autoFocus: true } : {}),
    ...(enterKeyHint ? { enterKeyHint } : {}),
    ...(onKeyDown ? { onKeyDown } : {}),
    ...(hideLabel ? { 'aria-label': label } : {}),
  };
  // Подпись и ошибка вокруг одного контрола; при hideLabel подпись — aria-label, ошибка под полем
  const wrap = (control: React.ReactElement<{ id?: string; name?: string }>) =>
    hideLabel ? (
      <div className="flex flex-col gap-1">
        {control}
        {error && (
          <p className="k-field__error" role="alert">
            <span>{error}</span>
          </p>
        )}
      </div>
    ) : (
      <Field label={label} error={error}>
        {control}
      </Field>
    );

  if (type === 'boolean') {
    return <Checkbox {...common} label={label} checked={value === true} error={error} onChange={(e) => onChange(e.target.checked)} />;
  }
  if (type === 'multiselect') {
    const chosen = Array.isArray(value) ? value : [];
    return (
      <fieldset className="flex flex-col gap-2" onKeyDown={onKeyDown}>
        <legend className={hideLabel ? 'sr-only' : 'k-field__label'}>{label}</legend>
        {options.map((o) => (
          <Checkbox
            key={o.key}
            name={`${name}-${o.key}`}
            label={o.label}
            checked={chosen.includes(o.key)}
            disabled={o.archived === true && !chosen.includes(o.key)}
            onChange={(e) => onChange(e.target.checked ? [...chosen, o.key] : chosen.filter((k) => k !== o.key))}
          />
        ))}
        {error && <p className="k-field__error">{error}</p>}
      </fieldset>
    );
  }
  const str = typeof value === 'string' ? value : '';
  if (type === 'select') {
    return wrap(
      <Select {...common} value={str} onChange={(e) => onChange(e.target.value)}>
        <option value="">{emptyLabel}</option>
        {options.map((o) => (
          <option key={o.key} value={o.key} disabled={o.archived === true && o.key !== str}>
            {o.label}
          </option>
        ))}
      </Select>,
    );
  }
  if (type === 'textarea') {
    return wrap(<Textarea {...common} rows={3} value={str} onChange={(e) => onChange(e.target.value)} />);
  }
  const inputMode = type === 'number' ? 'decimal' : type === 'money' ? 'numeric' : type === 'phone' ? 'tel' : undefined;
  const handle = (raw: string): string => {
    if (type === 'phone') return maskPhone(raw);
    if (type === 'money') {
      // Запятая и точка не выбрасываются молча (иначе «1500,50» стало бы 150050): разбор покажет ошибку
      const clean = raw.replace(/[^\d\s.,\u00a0]/g, '');
      if (/[.,]/.test(clean)) return clean;
      const digits = clean.replace(/\D/g, '');
      return digits === '' ? '' : groupDigits(digits);
    }
    if (type === 'number') return raw.replace(/[^\d,.\-\s]/g, '');
    return raw;
  };
  return wrap(
    <Input
      {...common}
      type={INPUT_TYPE[type] ?? 'text'}
      inputMode={inputMode}
      autoComplete="off"
      value={str}
      onChange={(e) => onChange(handle(e.target.value))}
    />,
  );
}
