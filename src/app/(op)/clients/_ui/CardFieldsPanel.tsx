'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { BottomSheet, Button, Card, useToast } from '@/ui/kit';
import { isInlineType } from '@/ui/fields/inline';
import { InlineRows, type InlineRow } from './InlineRows';
import { saveInline } from './inlineSave';
import { FieldValueView } from './FieldValueView';
import { FieldsForm, type FormBody, type SubmitResult } from './FieldsForm';
import { labelOf } from './format';
import { send } from './requests';
import type { FieldView } from './types';

type Props = { cardId: string; version: number; fields: FieldView[]; canEdit: boolean; /** Ввод на месте (флаг CALLBACK_V2). */ inline?: boolean };

/** Поля карточки обзвона (объект `card`): правка с версией карточки; устаревшая версия — 409 и свежие данные. */
export function CardFieldsPanel({ cardId, version, fields, canEdit, inline = false }: Props) {
  const t = useTranslations('clients');
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const shown = fields.filter((f) => f.showOn.card);
  if (shown.length === 0) return null;

  const inlineRows: InlineRow[] = shown.map((f) => ({
    field: {
      object: 'card',
      key: f.key,
      type: f.type,
      label: labelOf(f.label),
      options: f.options.map((o) => ({ key: o.key, label: labelOf(o.label), archived: o.archived })),
      editable: canEdit && f.access === 'edit' && !f.archived && isInlineType(f.type),
    },
    value: f.value,
    save: (next, prev) => saveInline({ object: 'card', key: f.key, cardId }, next, prev),
    readView: <FieldValueView f={f} yes={t('fields.yes')} no={t('fields.no')} />,
  }));

  async function submit(body: FormBody): Promise<SubmitResult> {
    const { result } = await send('PATCH', `/api/cards/${cardId}`, { version, set: { custom: body.set.custom }, expect: { custom: body.expect.custom } });
    if (result.ok) {
      setOpen(false);
      toast.show({ message: t('cardFields.saved'), tone: 'success' });
      router.refresh();
    } else if (result.kind === 'conflict') {
      setOpen(false);
      toast.show({ message: t('form.failure.conflict'), tone: 'danger' });
      router.refresh();
    }
    return result;
  }

  return (
    <Card as="section" aria-labelledby="card-fields-title">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 id="card-fields-title" className="text-lg font-semibold">
          {t('cardFields.title')}
        </h2>
        {canEdit && (
          <Button variant={inline ? 'quiet' : 'secondary'} size="sm" onClick={() => setOpen(true)} data-testid="card-fields-edit-all">
            {inline ? t('fields.inline.editAll') : t('fields.edit')}
          </Button>
        )}
      </div>
      {inline ? (
        <InlineRows rows={inlineRows} onRefresh={() => router.refresh()} />
      ) : (
      <dl>
        {shown.map((f) => (
          <div className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-2 py-1.5 sm:grid-cols-[12rem_minmax(0,1fr)]" key={f.key}>
            <dt className="text-[var(--text-2)]">{labelOf(f.label)}</dt>
            <dd className="break-words">
              <FieldValueView f={f} yes={t('fields.yes')} no={t('fields.no')} />
            </dd>
          </div>
        ))}
      </dl>
      )}
      {canEdit && (
        <BottomSheet open={open} onClose={() => setOpen(false)} title={t('cardFields.editTitle')} closeLabel={t('form.close')}>
          <FieldsForm mode="edit" systemFields={[]} customFields={fields} submitLabel={t('form.save')} onSubmit={submit} onCancel={() => setOpen(false)} />
        </BottomSheet>
      )}
    </Card>
  );
}
