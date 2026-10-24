'use client';

// Список полей с вводом на месте: заполненные — строками, пустые с правом правки свёрнуты в «Пустые поля (N)»
// (шторка лида и карточка обзвона не должны терять пол-экрана на «Добавить», D-356). Раскрытое остаётся раскрытым.
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button } from '@/ui/kit';
import { isEmptyValue } from '@/ui/fields/draft';
import { CardFieldRow } from './CardFieldRow';
import type { CardFieldLabel } from './types';

export type FieldItem = { field: CardFieldLabel; value: unknown };

type Props = {
  /** Заполненные поля (порядок сохраняется). */
  rows: readonly FieldItem[];
  /** Пустые поля, которые можно заполнить. */
  empties: readonly FieldItem[];
  cardId: string;
  clientId: string;
  onValue: (field: CardFieldLabel, value: unknown) => void;
  fetchFn?: typeof fetch;
  testId?: string;
};

/** Делит поля на заполненные и пустые: «пусто» — null, пустая строка и пустой список (false заполнено). */
export function splitEmpty(items: readonly FieldItem[]): { filled: FieldItem[]; empty: FieldItem[] } {
  return { filled: items.filter((i) => !isEmptyValue(i.value)), empty: items.filter((i) => isEmptyValue(i.value)) };
}

export function CardFieldList({ rows, empties, cardId, clientId, onValue, fetchFn, testId = 'card-fields' }: Props) {
  const t = useTranslations('call');
  const [open, setOpen] = useState(false);
  // Только что правленное поле остаётся на виду, даже если стало пустым или было пустым и заполнилось
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
  const idOf = (i: FieldItem) => `${i.field.object}-${i.field.key}`;
  const visible = [...rows, ...empties.filter((i) => kept.has(idOf(i)))];
  const hidden = empties.filter((i) => !kept.has(idOf(i)));
  const render = (i: FieldItem) => (
    <CardFieldRow
      key={`${i.field.object}-${i.field.key}`}
      field={i.field}
      value={i.value}
      cardId={cardId}
      clientId={clientId}
      onValue={(_k, v) => {
        setKept((cur) => new Set(cur).add(idOf(i)));
        onValue(i.field, v);
      }}
      {...(fetchFn ? { fetchFn } : {})}
    />
  );
  return (
    <div className="flex flex-col" data-testid={testId}>
      <dl className="text-sm">
        {visible.map(render)}
        {open && hidden.map(render)}
      </dl>
      {hidden.length > 0 && (
        <Button variant="quiet" size="sm" flush className="self-start" onClick={() => setOpen((x) => !x)} aria-expanded={open} data-testid="fields-empty-toggle">
          {open ? t('card.field.inline.emptyHide') : t('card.field.inline.emptyFields', { count: hidden.length })}
        </Button>
      )}
    </div>
  );
}
