// Источник: платформа LMS 2cd8a2b src/components/ui/Stat.tsx (адаптировано под CRM)
import type { ReactNode } from 'react';
import { cn } from './cn';

type Props = {
  value: ReactNode;
  label: ReactNode;
  hint?: ReactNode;
  /** danger — число, требующее внимания (просрочено). Рядом всегда подпись. */
  tone?: 'default' | 'danger';
  className?: string;
};

/** Счётчик: число + подпись («К звонку сейчас», «Просрочено»). */
export function Stat({ value, label, hint, tone = 'default', className }: Props) {
  return (
    <div className={cn('k-stat', tone === 'danger' && 'k-stat--danger', className)}>
      <span className="k-stat__value">{value}</span>
      <span className="k-stat__label">{label}</span>
      {hint && <span className="k-stat__hint">{hint}</span>}
    </div>
  );
}
