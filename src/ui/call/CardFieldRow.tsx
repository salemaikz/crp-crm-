'use client';

// Строка поля в карточке обзвона и шторке лида (pipeline-v2 §9.6, D-356): тонкая обёртка над общим InlineField.
// Значение — кнопка: нажатие открывает на месте ввод по типу поля, Enter или потеря фокуса сохраняют одно поле, Esc отменяет.
// Пустое поле с правом правки — «Добавить» на одной базовой линии с подписью. Без права — обычный текст.
import { useToast } from '@/ui/kit';
import { InlineField } from '@/ui/fields/InlineField';
import type { FieldPayload } from '@/ui/fields/draft';
import type { FieldSave } from '@/ui/fields/save';
import { saveField } from './fieldApi';
import { useInlineTexts } from './inlineTexts';
import type { CardFieldLabel } from './types';
import { useTranslations } from 'next-intl';

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
  const texts = useInlineTexts();
  const save = (next: FieldPayload, prev: unknown): Promise<FieldSave> => saveField({ object: field.object, key: field.key, cardId, clientId }, prev, next, fetchFn);
  return (
    <InlineField
      field={{ object: field.object, key: field.key, type: field.type, label: field.label, options: field.choices, editable: field.editable }}
      value={value}
      save={save}
      texts={texts}
      layout="row"
      onValue={(v) => {
        onValue(field.key, v);
        toast.show({ message: t('card.field.saved'), tone: 'success' });
      }}
      onRefresh={() => toast.show({ message: t('card.field.conflict'), tone: 'danger' })}
    />
  );
}
