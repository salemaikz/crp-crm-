// Источник: платформа LMS 2cd8a2b src/components/ui/PageHeader.tsx (адаптировано под CRM)
import type { ReactNode } from 'react';
import { cn } from './cn';

type Props = {
  title: ReactNode;
  /** Одна строка пояснения. */
  lead?: ReactNode;
  /** Главное действие экрана (одна primary-кнопка) и второстепенные. */
  actions?: ReactNode;
  breadcrumbs?: ReactNode;
  className?: string;
};

/** Шапка страницы: крошки, h1, пояснение, действия. */
export function PageHeader({ title, lead, actions, breadcrumbs, className }: Props) {
  return (
    <header className={cn('k-page-header', className)}>
      {breadcrumbs}
      <div className="k-page-header__row">
        <div>
          <h1 className="k-page-header__title">{title}</h1>
          {lead && <p className="k-page-header__lead">{lead}</p>}
        </div>
        {actions && <div className="k-page-header__actions">{actions}</div>}
      </div>
    </header>
  );
}
