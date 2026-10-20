// Источник: платформа LMS 2cd8a2b src/components/ui/Input.tsx (адаптировано под CRM)
import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { cn } from './cn';

type Invalid = { invalid?: boolean };

/** Текстовое поле: белое, рамка, радиус 12 px, фокус — графит + кольцо. */
export function Input({ className, invalid, ...rest }: InputHTMLAttributes<HTMLInputElement> & Invalid) {
  return <input className={cn('k-input', className)} aria-invalid={invalid || undefined} {...rest} />;
}

/** Выпадающий список (нативный select со своей стрелкой). */
export function Select({ className, invalid, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & Invalid) {
  return (
    <select className={cn('k-input k-select', className)} aria-invalid={invalid || undefined} {...rest}>
      {children}
    </select>
  );
}

/** Многострочное поле. */
export function Textarea({ className, invalid, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & Invalid) {
  return <textarea className={cn('k-input k-textarea', className)} aria-invalid={invalid || undefined} {...rest} />;
}
