// Источник: платформа LMS 2cd8a2b src/components/ui/Alert.tsx (адаптировано под CRM)
import type { HTMLAttributes, ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import { cn } from './cn';

type Tone = 'info' | 'success' | 'warning' | 'danger';

type Props = Omit<HTMLAttributes<HTMLDivElement>, 'title'> & {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
};

const ICONS = { info: Info, success: CircleCheck, warning: TriangleAlert, danger: CircleAlert } as const;

/** Сообщение на странице с иконкой. danger объявляется скринридером сразу. */
export function Alert({ tone = 'info', title, className, children, role, ...rest }: Props) {
  const Icon = ICONS[tone];
  return (
    <div role={role ?? (tone === 'danger' ? 'alert' : 'status')} className={cn('k-alert', `k-alert--${tone}`, className)} {...rest}>
      <Icon aria-hidden="true" />
      <div>
        {title && <strong className="k-alert__title">{title}</strong>}
        {children}
      </div>
    </div>
  );
}
