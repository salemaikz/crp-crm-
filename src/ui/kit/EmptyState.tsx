// Источник: платформа LMS 2cd8a2b src/components/ui/EmptyState.tsx (адаптировано под CRM)
import type { ReactNode } from 'react';
import { cn } from './cn';

type Props = {
  title: ReactNode;
  /** Одна строка: почему пусто и что делать. */
  description?: ReactNode;
  /** Линейная иконка lucide-react (по желанию). */
  icon?: ReactNode;
  /** Следующее действие. Не больше одной главной кнопки. */
  action?: ReactNode;
  framed?: boolean;
  headingLevel?: 'h2' | 'h3';
  className?: string;
};

/** Пустое состояние: что здесь будет, почему пусто и следующий шаг. Пустой список без слов недопустим. */
export function EmptyState({ title, description, icon, action, framed = true, headingLevel: H = 'h2', className }: Props) {
  return (
    <div className={cn('k-empty', framed && 'k-card k-card--p-lg', className)}>
      {icon && (
        <div className="k-empty__icon" aria-hidden="true">
          {icon}
        </div>
      )}
      <H className="k-empty__title">{title}</H>
      {description && <p className="k-empty__text">{description}</p>}
      {action && <div className="k-empty__actions">{action}</div>}
    </div>
  );
}
