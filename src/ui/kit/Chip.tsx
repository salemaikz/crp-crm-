// Источник: платформа LMS 2cd8a2b src/components/ui/Chip.tsx (адаптировано под CRM)
import { useId, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';
import Link from 'next/link';
import { cn } from './cn';

type Props = {
  active?: boolean;
  /** Счётчик справа («Просрочено 2»). */
  count?: number;
  className?: string;
  children: ReactNode;
} & (
  | ({ href?: undefined } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'>)
  | { href: string; scroll?: boolean }
);

/** Быстрый фильтр: кнопка (aria-pressed) или ссылка (aria-current). Активный — залит брендом. */
export function Chip(props: Props) {
  const { active, count, className, children } = props;
  const inner = (
    <>
      {children}
      {count !== undefined && <span className="k-chip__count">{count}</span>}
    </>
  );
  if (typeof props.href === 'string') {
    return (
      <Link
        href={props.href}
        scroll={props.scroll}
        aria-current={active ? 'page' : undefined}
        className={cn('k-chip', className)}
      >
        {inner}
      </Link>
    );
  }
  const { active: _a, count: _c, className: _cl, children: _ch, href: _h, type = 'button', ...rest } = props;
  void [_a, _c, _cl, _ch, _h];
  return (
    <button type={type} aria-pressed={active ?? false} className={cn('k-chip', className)} {...rest}>
      {inner}
    </button>
  );
}

/**
 * Ряд чипов-фильтров: на телефоне прокручивается по горизонтали, а не переносится. `showLabel` — видимая подпись группы
 * над рядом (шторки: «Причина», «Когда перезвонить»): на телефоне `aria-label` не виден, а группа без подписи не читается.
 */
export function ChipGroup({
  label,
  showLabel,
  className,
  children,
  ...rest
}: Omit<HTMLAttributes<HTMLDivElement>, 'aria-label'> & { label: string; showLabel?: boolean }) {
  const id = useId();
  if (!showLabel) {
    return (
      <div role="group" aria-label={label} className={cn('k-chips', className)} {...rest}>
        {children}
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span id={id} className="text-sm font-semibold">
        {label}
      </span>
      <div role="group" aria-labelledby={id} className={cn('k-chips', className)} {...rest}>
        {children}
      </div>
    </div>
  );
}
