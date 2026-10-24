'use client';

// Список полей карточки клиента с вводом на месте (D-356): общая часть «Данных клиента» и «Полей карточки».
// Правится только поле с правом (`editable`); без права — текст. Пустые поля с правом на телефоне свёрнуты в
// «Пустые поля (N)», без права пустые не показываются. После сохранения значение обновляется на месте, лента — по сигналу.
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { Button } from '@/ui/kit';
import { isEmptyValue } from '@/ui/fields/draft';
import { InlineField, type InlineFieldDef } from '@/ui/fields/InlineField';
import type { FieldPayload } from '@/ui/fields/draft';
import type { FieldSave } from '@/ui/fields/save';
import { useFeedControl } from './ClientsProviders';
import { useInlineTexts } from './useInlineTexts';

export type InlineRow = {
  field: InlineFieldDef;
  value: unknown;
  save: (next: FieldPayload, prev: unknown) => Promise<FieldSave>;
  /** Показ без права правки (ссылка, почта). */
  readView?: ReactNode;
};

export function InlineRows({ rows, onRefresh }: { rows: InlineRow[]; onRefresh?: () => void }) {
  const t = useTranslations('clients');
  const texts = useInlineTexts();
  const feed = useFeedControl();
  const [expanded, setExpanded] = useState(false);
  // Значения после правки на месте и ключи, которые остаются на виду, даже если стали пустыми
  const [local, setLocal] = useState<Record<string, unknown>>({});
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
  const [seen, setSeen] = useState('');
  const incoming = JSON.stringify(rows.map((r) => [r.field.key, r.value ?? null]));
  if (incoming !== seen) {
    setSeen(incoming);
    setLocal({});
  }

  const idOf = (r: InlineRow) => `${r.field.object}:${r.field.key}`;
  const valueOf = (r: InlineRow) => (Object.hasOwn(local, idOf(r)) ? local[idOf(r)] : r.value);
  // Пустые без права не показываем вовсе; пустые с правом — свёрнуты на телефоне, пока их не раскрыли
  const visible = rows.filter((r) => !isEmptyValue(valueOf(r)) || r.field.editable || kept.has(idOf(r)));
  const foldable = visible.filter((r) => isEmptyValue(valueOf(r)) && !kept.has(idOf(r)));

  return (
    <div data-testid="inline-rows">
      <dl className="flex flex-col">
        {visible.map((r) => {
          const id = idOf(r);
          const empty = isEmptyValue(valueOf(r)) && !kept.has(id);
          return (
            <InlineField
              key={id}
              field={r.field}
              value={valueOf(r)}
              save={r.save}
              texts={texts}
              layout="auto"
              readView={r.readView}
              {...(empty && !expanded ? { className: 'max-sm:hidden' } : {})}
              onValue={(v) => {
                setLocal((cur) => ({ ...cur, [id]: v }));
                setKept((cur) => new Set(cur).add(id));
                feed.reload();
              }}
              {...(onRefresh ? { onRefresh } : {})}
            />
          );
        })}
      </dl>
      {foldable.length > 0 && !expanded && (
        <div className="pt-1 sm:hidden">
          <Button variant="quiet" size="sm" flush onClick={() => setExpanded(true)} data-testid="inline-empty-toggle">
            {t('fields.inline.emptyFields', { count: foldable.length })}
          </Button>
        </div>
      )}
    </div>
  );
}
