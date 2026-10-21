// Источник: платформа LMS 2cd8a2b src/components/ui/Badge.tsx (адаптировано под CRM)
import type { HTMLAttributes, ReactNode } from 'react';
import { Check, CircleDot, Clock, Info, X } from 'lucide-react';
import { cn } from './cn';

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'info' | 'danger' | 'brand';

// У нейтрального тона значка-«минуса» нет: он читался как «минус 5». Вместо него точка.
const ICONS = {
  success: Check,
  warning: Clock,
  info: Info,
  danger: X,
  brand: CircleDot,
} as const;

type Props = HTMLAttributes<HTMLSpanElement> & {
  tone?: BadgeTone;
  /** Свой значок (lucide-react). По умолчанию — значок тона. */
  icon?: ReactNode;
  /** count — число без значка (счётчики колонок, «Просрочено 1»). */
  variant?: 'state' | 'count';
  /** Текст обязателен: состояние не передаётся одним цветом. */
  children: ReactNode;
};

/**
 * Бейдж состояния: цвет + значок + текст. Значок скрывается только настройкой theme.statusStyle=color
 * (переменная --status-icon-display); текст остаётся всегда.
 */
export function Badge({ tone = 'neutral', variant = 'state', icon, className, children, ...rest }: Props) {
  if (variant === 'count') {
    return (
      <span className={cn('k-badge', 'k-badge--count', `k-badge--${tone}`, className)} {...rest}>
        {children}
      </span>
    );
  }
  const Icon = tone === 'neutral' ? null : ICONS[tone];
  return (
    <span className={cn('k-badge', `k-badge--${tone}`, className)} {...rest}>
      <span className="k-badge__icon" aria-hidden="true">
        {icon ?? (Icon ? <Icon /> : <span className="k-badge__dot" />)}
      </span>
      {children}
    </span>
  );
}
