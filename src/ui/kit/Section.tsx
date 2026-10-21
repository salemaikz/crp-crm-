import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

type Props = Omit<HTMLAttributes<HTMLElement>, 'title'> & {
  title: ReactNode;
  /** Действия раздела: справа в строке заголовка (`secondary sm` или `quiet sm`). */
  actions?: ReactNode;
  children?: ReactNode;
};

/** Раздел страницы: h2 слева, действия справа в одной строке; ниже содержимое. */
export function Section({ title, actions, className, children, ...rest }: Props) {
  return (
    <section className={cn('k-section', className)} {...rest}>
      <div className="k-section__head">
        <h2 className="k-section__title">{title}</h2>
        {actions && <div className="k-section__actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
