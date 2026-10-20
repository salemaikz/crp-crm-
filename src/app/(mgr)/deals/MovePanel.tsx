'use client';

// Панель переноса (B8, D-266): только то, чего не хватает этапу, — следующий шаг и поля. «Перенести» отправляет сразу
// (явное подтверждение, без «Отменить»). Время шага — в поясе установки.
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { BottomSheet, Button, Field, Input, Select, Textarea } from '@/ui/kit';
import { fromInputValue } from '@/ui/call/zoned';
import type { BoardFieldDef } from './types';
import type { StageExtras } from './api';

type Props = {
  title: string;
  nextStep: boolean;
  fields: BoardFieldDef[];
  timeZone: string;
  busy: boolean;
  /** Ключ ошибки сервера (`deals.board.errors.*`) — показывается под формой. */
  error: string | null;
  onClose: () => void;
  onSubmit: (extras: StageExtras) => void;
};

/** Значение поля из ввода: число для number/money, пустое — нет значения. */
function parse(def: BoardFieldDef, raw: string): unknown {
  const v = raw.trim();
  if (v === '') return null;
  if (def.type === 'number' || def.type === 'money') {
    const n = Number(v.replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  return v;
}

export function MovePanel({ title, nextStep, fields, timeZone, busy, error, onClose, onSubmit }: Props) {
  const t = useTranslations('deals.board');
  const [kind, setKind] = useState<'call' | 'meeting'>('call');
  const [due, setDue] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});

  const dueAt = due === '' ? null : fromInputValue(due, timeZone);
  const parsed = fields.map((d) => [d, parse(d, values[d.key] ?? '')] as const);
  const ready = (!nextStep || dueAt !== null) && parsed.every(([, v]) => v !== null);

  const submit = () => {
    if (!ready) return;
    onSubmit({
      nextStep: nextStep && dueAt !== null ? { dueAt, kind } : null,
      ...(fields.length > 0 ? { fieldsPatch: Object.fromEntries(parsed.map(([d, v]) => [d.key, v])) } : {}),
    });
  };

  return (
    <BottomSheet
      open
      onClose={onClose}
      closeLabel={t('panel.close')}
      title={title}
      description={t('panel.lead')}
      footer={
        <Button size="lg" block disabled={!ready || busy} onClick={submit} data-testid="move-submit">
          {t('panel.submit')}
        </Button>
      }
    >
      <div className="flex flex-col gap-3" data-testid="move-panel">
        {nextStep && (
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-semibold">{t('panel.nextStep')}</legend>
            <Field label={t('panel.nextStepKind')}>
              <Select value={kind} onChange={(e) => setKind(e.target.value === 'meeting' ? 'meeting' : 'call')}>
                <option value="call">{t('panel.kind.call')}</option>
                <option value="meeting">{t('panel.kind.meeting')}</option>
              </Select>
            </Field>
            <Field label={t('panel.nextStepDue')}>
              <Input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} data-testid="move-due" />
            </Field>
          </fieldset>
        )}
        {fields.map((d) => (
          <Field key={d.key} label={d.label}>
            {d.type === 'select' ? (
              <Select value={values[d.key] ?? ''} onChange={(e) => setValues({ ...values, [d.key]: e.target.value })}>
                <option value="">{t('panel.choose')}</option>
                {d.options.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </Select>
            ) : d.type === 'textarea' ? (
              <Textarea rows={3} maxLength={2000} value={values[d.key] ?? ''} onChange={(e) => setValues({ ...values, [d.key]: e.target.value })} />
            ) : (
              <Input
                type={d.type === 'date' ? 'date' : 'text'}
                inputMode={d.type === 'number' || d.type === 'money' ? 'decimal' : undefined}
                maxLength={500}
                value={values[d.key] ?? ''}
                onChange={(e) => setValues({ ...values, [d.key]: e.target.value })}
                data-testid={`move-field-${d.key}`}
              />
            )}
          </Field>
        ))}
        {error && (
          <p role="alert" className="text-sm" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        )}
      </div>
    </BottomSheet>
  );
}
