// Источник: платформа LMS 2cd8a2b src/components/ui/PageHeader.tsx (адаптировано под CRM)
import type { ReactNode } from 'react';
import { cn } from './cn';

type Props = {
  title: ReactNode;
  /** Одна строка пояснения под заголовком, на всю ширину. */
  lead?: ReactNode;
  /**
   * Действия экрана — в одной строке с заголовком, справа. Не больше одной primary, остальное
   * secondary/quiet размера sm.
   */
  actions?: ReactNode;
  breadcrumbs?: ReactNode;
  /** Ссылка «назад» над заголовком (вместо разрозненных «К списку»). */
  back?: ReactNode;
  /** Бейдж состояния справа от заголовка. */
  meta?: ReactNode;
  /** Переключатель видов страницы под пояснением (`Segmented`). */
  tabs?: ReactNode;
  className?: string;
};

/** Шапка страницы: назад/крошки, h1 с состоянием и действиями в одной строке, пояснение, виды. */
export function PageHeader({ title, lead, actions, breadcrumbs, back, meta, tabs, className }: Props) {
  return (
    <header className={cn('k-page-header', className)}>
      {back}
      {breadcrumbs}
      <div className="k-page-header__row">
        <div className="k-page-header__heading">
          <h1 className="k-page-header__title">{title}</h1>
          {meta}
        </div>
        {actions && <div className="k-page-header__actions">{actions}</div>}
      </div>
      {lead && <p className="k-page-header__lead">{lead}</p>}
      {tabs && <div className="k-page-header__tabs">{tabs}</div>}
    </header>
  );
}
