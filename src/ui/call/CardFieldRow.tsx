'use client';

// Строка поля в карточке обзвона (pipeline-v2 §9.6). Значение — кнопка: нажатие открывает на месте нужный
// элемент ввода, «Сохранить» или Enter сохраняет одно поле. Пустое поле с правом правки — «Добавить …».
// Без права правки — обычный текст без кнопки.
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button, useToast } from '@/ui/kit';
import { draftOf, isEmptyValue, payloadOf, type FieldDraft } from '@/ui/fields/draft';
import { FieldControl } from '@/ui/fields/FieldControl';
import { fieldText } from './fieldText';
import { saveField } from './fieldApi';
import type { CardFieldLabel } from './types';

type Props = {
  field: CardFieldLabel;
  value: unknown;
  cardId: string;
  clientId: string;
  /** Новое значение после сохранения или после 409 (чужое значение показывается сразу). */
  onValue: (key: string, value: unknown) => void;
  /** Защищённый запрос (доска на общем телефоне); по умолчанию обычный fetch. */
  fetchFn?: typeof fetch;
};

export function CardFieldRow({ field, value, cardId, clientId, onValue, fetchFn }: Props) {
  const t = useTranslations('call');
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<FieldDraft>('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const text = fieldText(value, field.options) || (typeof value === 'boolean' ? t(value ? 'card.field.yes' : 'card.field.no') : '');
  const empty = isEmptyValue(value);

  const open = () => {
    setDraft(draftOf(field.type, value));
    setError(undefined);
    setEditing(true);
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    const next = payloadOf(draft);
    const r = await saveField({ object: field.object, key: field.key, cardId, clientId }, value, next, fetchFn);
    setBusy(false);
    if (r.ok) {
      onValue(field.key, next);
      setEditing(false);
      toast.show({ message: t('card.field.saved'), tone: 'success' });
    } else if (r.kind === 'conflict') {
      if (r.known) onValue(field.key, r.current);
      setEditing(false);
      toast.show({ message: t('card.field.conflict'), tone: 'danger' });
    } else if (r.kind === 'fields' || r.kind === 'invalid') {
      setError(t('card.field.invalid'));
    } else if (r.kind === 'forbidden') {
      setEditing(false);
      toast.show({ message: t('card.field.forbidden'), tone: 'danger' });
    } else {
      setError(t('card.field.network'));
    }
  };

  return (
    <div className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] items-start gap-2 py-1" data-testid={`field-row-${field.key}`}>
      <dt style={{ color: 'var(--text-2)' }}>{field.label}</dt>
      <dd className="break-words">
        {editing ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <FieldControl
              type={field.type}
              label={field.label}
              value={draft}
              onChange={setDraft}
              options={field.choices}
              emptyLabel={t('card.field.notChosen')}
              error={error}
              name={`call-${field.key}`}
              autoFocus
            />
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={busy} data-testid="field-save">
                {t('card.field.save')}
              </Button>
              <Button type="button" variant="quiet" size="sm" disabled={busy} onClick={() => setEditing(false)} data-testid="field-cancel">
                {t('card.field.cancel')}
              </Button>
            </div>
          </form>
        ) : field.editable ? (
          <button
            type="button"
            className="min-h-11 w-full text-left underline decoration-dotted underline-offset-4"
            style={empty ? { color: 'var(--text-3)' } : undefined}
            aria-label={t(empty ? 'card.field.addAria' : 'card.field.editAria', { label: field.label })}
            onClick={open}
            data-testid={`field-edit-${field.key}`}
          >
            {empty ? t('card.field.add', { label: field.label }) : text}
          </button>
        ) : (
          text
        )}
      </dd>
    </div>
  );
}
