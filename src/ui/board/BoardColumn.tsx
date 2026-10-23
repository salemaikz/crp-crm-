'use client';

// Колонка доски: шапка (подпись из пресета и число), плитки, «Ещё». На ноутбуке — 18 rem в ряду, на телефоне — вся
// ширина экрана, одна на вкладку (scroll-snap). Цель переноса подсвечивается пунктиром, запрещённая гаснет.
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { Button } from '@/ui/kit';

export interface BoardColumnProps {
  columnKey: string;
  title: string;
  count: number;
  hasMore: boolean;
  loadingMore: boolean;
  /** Идёт перетаскивание: колонка — цель (`ok`), запрещена (`no`) или не участвует. */
  dropState: 'idle' | 'ok' | 'no';
  /** Цель под указателем. */
  over: boolean;
  /** Сортировка на устройстве упёрлась в предел колонки: вместо «Ещё» — подсказка «уточните поиск». */
  limited?: boolean;
  limit?: number;
  onMore: () => void;
  /** Строка под заголовком (итог месяца в «Покупке»). */
  summary?: ReactNode;
  children: ReactNode;
  empty: boolean;
}

export function BoardColumn(p: BoardColumnProps) {
  const t = useTranslations('board');
  return (
    <section
      data-column-key={p.columnKey}
      data-drop={p.dropState}
      aria-labelledby={`col-${p.columnKey}`}
      className="flex w-full shrink-0 snap-center flex-col gap-3 rounded-[var(--radius-card)] p-2 md:w-72 md:snap-align-none"
      style={{
        background: 'var(--canvas)',
        outline: p.dropState === 'ok' ? `2px dashed var(--brand)` : undefined,
        outlineOffset: -2,
        opacity: p.dropState === 'no' ? 0.45 : 1,
        boxShadow: p.over ? 'inset 0 0 0 9999px var(--brand-tint)' : undefined,
      }}
      data-testid={`column-${p.columnKey}`}
    >
      <header className="flex items-baseline justify-between gap-2 px-1">
        <h2 id={`col-${p.columnKey}`} className="text-base font-semibold">
          {p.title}
        </h2>
        <span className="text-sm" style={{ color: 'var(--text-2)' }} data-testid={`column-count-${p.columnKey}`}>
          {p.hasMore ? t('column.countMore', { n: p.count }) : p.count}
        </span>
      </header>
      {p.summary}
      <div className="flex flex-col gap-2">{p.children}</div>
      {p.empty && (
        <p className="px-1 py-4 text-center text-sm" style={{ color: 'var(--text-3)' }}>
          {t('column.empty')}
        </p>
      )}
      {p.hasMore && p.limited && (
        <p className="px-1 py-2 text-center text-sm" style={{ color: 'var(--text-2)' }} data-testid={`column-limit-${p.columnKey}`}>
          {t('column.limit', { n: p.limit ?? 0 })}
        </p>
      )}
      {p.hasMore && !p.limited && (
        <Button variant="secondary" block disabled={p.loadingMore} onClick={p.onMore} data-testid={`column-more-${p.columnKey}`}>
          {p.loadingMore ? t('column.loading') : t('column.more')}
        </Button>
      )}
    </section>
  );
}
