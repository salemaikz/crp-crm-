// Источник: платформа LMS 2cd8a2b src/components/ui/SubmitButton.tsx (адаптировано под CRM)
'use client';

import type { ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { Button, type ButtonAsButton } from './Button';

type Props = Omit<ButtonAsButton, 'type'> & {
  /** Текст на время отправки формы («Сохраняем…»). */
  pendingText?: ReactNode;
  /** Внешний флаг ожидания (например, isPending из useActionState). */
  pending?: boolean;
};

/** Кнопка отправки формы: блокируется и показывает спиннер, пока идёт server action. */
export function SubmitButton({ children, pendingText, pending: pendingProp, disabled, ...rest }: Props) {
  const status = useFormStatus();
  const pending = pendingProp ?? status.pending;
  return (
    <Button type="submit" disabled={disabled || pending} aria-busy={pending || undefined} {...rest}>
      {pending ? (
        <>
          <span className="k-spinner" aria-hidden="true" />
          {pendingText ?? children}
        </>
      ) : (
        children
      )}
    </Button>
  );
}
