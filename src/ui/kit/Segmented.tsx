import type { ReactNode } from 'react';
import Link from 'next/link';
import { cn } from './cn';

export type SegmentedItem = {
  id: string;
  label: ReactNode;
  active?: boolean;
  /** Есть href — ссылка (aria-current); нет — кнопка (aria-pressed, onSelect). */
  href?: string;
  count?: number;
  /** data-testid кнопки или ссылки (для e2e). */
  testId?: string;
};

type Props = {
  label: string;
  items: readonly SegmentedItem[];
  /** Для кнопок: выбор вида. */
  onSelect?: (id: string) => void;
  className?: string;
};

/**
 * Переключатель видов страницы (Пул / Участники, Записи / Мероприятия): соединённая группа, на телефоне
 * равные доли ширины. Фильтры списка остаются чипами (`ChipGroup`).
 */
export function Segmented({ label, items, onSelect, className }: Props) {
  return (
    <div role="group" aria-label={label} className={cn('k-segmented', className)}>
      {items.map((it) => {
        const inner = (
          <>
            {it.label}
            {it.count !== undefined && <span className="k-chip__count">{it.count}</span>}
          </>
        );
        return it.href ? (
          <Link key={it.id} href={it.href} aria-current={it.active ? 'page' : undefined} className="k-chip" data-testid={it.testId}>
            {inner}
          </Link>
        ) : (
          <button key={it.id} type="button" aria-pressed={it.active ?? false} className="k-chip" data-testid={it.testId} onClick={() => onSelect?.(it.id)}>
            {inner}
          </button>
        );
      })}
    </div>
  );
}
