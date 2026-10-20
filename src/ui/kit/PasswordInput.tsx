'use client';
// Источник: платформа LMS 2cd8a2b src/components/ui/PasswordInput.tsx (подписи — пропсами, без next-intl)

import { useState, type InputHTMLAttributes } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { cn } from './cn';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  invalid?: boolean;
  /** Подписи кнопки из локали (common.a11y.showPassword / hidePassword). */
  showLabel: string;
  hideLabel: string;
};

/** Поле пароля с кнопкой «показать/скрыть». Остальные пропсы уходят во внутренний input. */
export function PasswordInput({ className, invalid, showLabel, hideLabel, ...rest }: Props) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="k-input-group">
      <input
        type={visible ? 'text' : 'password'}
        className={cn('k-input', className)}
        aria-invalid={invalid || undefined}
        autoCapitalize="none"
        spellCheck={false}
        {...rest}
      />
      <button
        type="button"
        className="k-input-group__btn"
        aria-label={visible ? hideLabel : showLabel}
        aria-pressed={visible}
        onClick={() => setVisible((v) => !v)}
      >
        {visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
      </button>
    </div>
  );
}
