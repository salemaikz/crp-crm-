'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { BottomSheet, Button, Card, useToast } from '@/ui/kit';
import { FieldValueView } from './FieldValueView';
import { FieldsForm, type FormBody, type SubmitResult } from './FieldsForm';
import { labelOf } from './format';
import { send } from './requests';
import type { FieldView } from './types';

type Props = { cardId: string; version: number; fields: FieldView[]; canEdit: boolean };

/** Поля карточки обзвона (объект `card`): правка с версией карточки; устаревшая версия — 409 и свежие данные. */
export function CardFieldsPanel({ cardId, version, fields, canEdit }: Props) {
  const t = useTranslations('clients');
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const shown = fields.filter((f) => f.showOn.card);
  if (shown.length === 0) return null;

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
          <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
            {t('fields.edit')}
          </Button>
        )}
      </div>
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
      {canEdit && (
        <BottomSheet open={open} onClose={() => setOpen(false)} title={t('cardFields.editTitle')} closeLabel={t('form.close')}>
          <FieldsForm mode="edit" systemFields={[]} customFields={fields} submitLabel={t('form.save')} onSubmit={submit} onCancel={() => setOpen(false)} />
        </BottomSheet>
      )}
    </Card>
  );
}
