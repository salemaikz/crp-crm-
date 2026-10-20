'use client';

import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Checkbox, Field, Input, Select, Textarea } from '@/ui/kit';
import { FieldControl, draftOf, isFormField, payloadOf, type Draft } from './FieldControl';
import { labelOf } from './format';
import type { FieldValue, FieldView, LegalFormOption } from './types';

/** Системное поле (колонка): ключ как в API. */
export type SystemSpec = {
  key: string;
  kind: 'text' | 'textarea' | 'email' | 'url' | 'bin' | 'legal_form' | 'boolean';
  label: string;
  value: string | boolean;
  editable: boolean;
};

export type SubmitResult =
  | { ok: true }
  | { ok: false; kind: 'fields'; issues: Array<{ key: string; code: string }> }
  | { ok: false; kind: 'conflict' | 'forbidden' | 'network' | 'invalid' };

export type FormBody = {
  set: { system: Record<string, unknown>; custom: Record<string, unknown> };
  expect: { system: Record<string, unknown>; custom: Record<string, unknown> };
};

type Props = {
  mode: 'edit' | 'create';
  systemFields: SystemSpec[];
  customFields: FieldView[];
  legalForms?: LegalFormOption[];
  submitLabel: string;
  onSubmit: (body: FormBody) => Promise<SubmitResult>;
  onCancel: () => void;
  /** Дополнительное действие (например, «В архив») рядом с отправкой. */
  extra?: React.ReactNode;
};

const ISSUE_CODES = new Set(['unknown_field', 'forbidden', 'archived', 'type', 'too_long', 'option', 'url', 'email', 'phone', 'range', 'date', 'required']);

/**
 * Форма правки полей. В режиме edit отправляются только изменённые поля вместе с тем, что пользователь
 * видел до правки (`expect`); в режиме create — только непустые.
 */
export function FieldsForm({ mode, systemFields, customFields, legalForms = [], submitLabel, onSubmit, onCancel, extra }: Props) {
  const t = useTranslations('clients');
  const editableCustom = customFields.filter(isFormField);
  const [sys, setSys] = useState<Record<string, string | boolean>>(() => Object.fromEntries(systemFields.map((s) => [s.key, s.value])));
  const [cus, setCus] = useState<Record<string, Draft>>(() => Object.fromEntries(editableCustom.map((f) => [f.key, draftOf(f)])));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const issueText = (code: string) => t(`errors.${ISSUE_CODES.has(code) ? code : 'type'}`);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const body: FormBody = { set: { system: {}, custom: {} }, expect: { system: {}, custom: {} } };
    for (const s of systemFields.filter((x) => x.editable)) {
      const now = sys[s.key];
      if (mode === 'edit' ? now !== s.value : now !== '' && now !== false) {
        body.set.system[s.key] = typeof now === 'string' ? now.trim() : now;
        if (mode === 'edit') body.expect.system[s.key] = s.value;
      }
    }
    for (const f of editableCustom) {
      const now = payloadOf(f, cus[f.key] ?? draftOf(f));
      const before = payloadOf(f, draftOf(f));
      if (mode === 'edit' ? JSON.stringify(now) !== JSON.stringify(before) : now !== null && now !== false) {
        body.set.custom[f.key] = now;
        if (mode === 'edit') body.expect.custom[f.key] = f.value as FieldValue | null;
      }
    }
    if (mode === 'edit' && Object.keys(body.set.system).length + Object.keys(body.set.custom).length === 0) {
      onCancel();
      return;
    }
    setBusy(true);
    setBanner(null);
    setErrors({});
    const r = await onSubmit(body);
    setBusy(false);
    if (r.ok) return;
    if (r.kind === 'fields') {
      setErrors(Object.fromEntries(r.issues.map((i) => [i.key, issueText(i.code)])));
      setBanner(t('form.fixFields'));
    } else {
      setBanner(t(`form.failure.${r.kind}`));
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      {banner && <Alert tone="danger">{banner}</Alert>}
      {systemFields.map((s) => {
        if (!s.editable) return null;
        const err = errors[s.key];
        if (s.kind === 'boolean') {
          return (
            <Checkbox key={s.key} name={`sys-${s.key}`} label={s.label} checked={sys[s.key] === true} error={err} onChange={(e) => setSys({ ...sys, [s.key]: e.target.checked })} />
          );
        }
        if (s.kind === 'legal_form') {
          return (
            <Field key={s.key} label={s.label} error={err}>
              <Select name={`sys-${s.key}`} value={String(sys[s.key] ?? '')} onChange={(e) => setSys({ ...sys, [s.key]: e.target.value })}>
                <option value="">{t('form.notChosen')}</option>
                {legalForms.map((f) => (
                  <option key={f.key} value={f.key}>
                    {labelOf(f.label)}
                  </option>
                ))}
              </Select>
            </Field>
          );
        }
        if (s.kind === 'textarea') {
          return (
            <Field key={s.key} label={s.label} error={err}>
              <Textarea name={`sys-${s.key}`} rows={3} value={String(sys[s.key] ?? '')} onChange={(e) => setSys({ ...sys, [s.key]: e.target.value })} />
            </Field>
          );
        }
        const type = s.kind === 'email' ? 'email' : s.kind === 'url' ? 'url' : 'text';
        return (
          <Field key={s.key} label={s.label} error={err}>
            <Input name={`sys-${s.key}`} type={type} inputMode={s.kind === 'bin' ? 'numeric' : undefined} value={String(sys[s.key] ?? '')} onChange={(e) => setSys({ ...sys, [s.key]: e.target.value })} />
          </Field>
        );
      })}
      {editableCustom.map((f) => (
        <FieldControl key={f.key} def={f} name={`cus-${f.key}`} value={cus[f.key] ?? draftOf(f)} error={errors[f.key]} onChange={(v) => setCus({ ...cus, [f.key]: v })} />
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? t('form.saving') : submitLabel}
        </Button>
        <Button type="button" variant="quiet" onClick={onCancel}>
          {t('form.cancel')}
        </Button>
        {extra}
      </div>
    </form>
  );
}
