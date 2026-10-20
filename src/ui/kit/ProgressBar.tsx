// Источник: платформа LMS 2cd8a2b src/components/ui/ProgressBar.tsx (адаптировано под CRM)
import type { ReactNode } from 'react';
import { cn } from './cn';

type Props = {
  /** 0..100, значения вне диапазона обрезаются. */
  value: number;
  /** Подпись (обязательна для доступности). */
  label: ReactNode;
  ariaLabel?: string;
  hideLabel?: boolean;
  showValue?: boolean;
  size?: 'sm' | 'md';
  className?: string;
};

/** Полоса прогресса (выполнение плана, дозвон). Значение выводится и числом. */
export function ProgressBar({ value, label, ariaLabel, hideLabel, showValue = true, size = 'md', className }: Props) {
  const v = Math.max(0, Math.min(100, Math.round(Number.isFinite(value) ? value : 0)));
  const textLabel = ariaLabel ?? (typeof label === 'string' ? label : undefined);
  return (
    <div className={cn('k-progress', size === 'sm' && 'k-progress--sm', className)}>
      {(!hideLabel || showValue) && (
        <div className="k-progress__head">
          <span className={hideLabel ? 'k-visually-hidden' : undefined}>{label}</span>
          {showValue && (
            <span className="k-progress__value" aria-hidden="true">
              {v}%
            </span>
          )}
        </div>
      )}
      <div className="k-progress__track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={v} aria-label={textLabel}>
        <span className="k-progress__fill" style={{ width: `${v}%` }} />
      </div>
    </div>
  );
}
