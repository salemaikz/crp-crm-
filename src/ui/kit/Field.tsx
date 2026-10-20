// Источник: платформа LMS 2cd8a2b src/components/ui/Field.tsx (адаптировано под CRM)
import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';
import { cn } from './cn';

type ControlProps = {
  id?: string;
  name?: string;
  required?: boolean;
  'aria-invalid'?: boolean | 'true' | 'false';
  'aria-describedby'?: string;
};

type Props = {
  label: ReactNode;
  /** Подсказка под полем. */
  hint?: ReactNode;
  /** Текст ошибки — поле получает aria-invalid и ссылку на ошибку. */
  error?: ReactNode;
  required?: boolean;
  /** Подпись «необязательно» рядом с меткой. */
  optionalLabel?: ReactNode;
  /** id поля; по умолчанию — из id или name дочернего контрола. */
  id?: string;
  className?: string;
  /** Ровно один контрол: <Input>, <Select>, <Textarea>, <PasswordInput>. */
  children: ReactElement<ControlProps>;
};

/**
 * Поле формы: метка + контрол + подсказка + ошибка (с иконкой, не только цветом).
 * Сам проставляет контролу id, aria-invalid и aria-describedby.
 */
export function Field({ label, hint, error, required, optionalLabel, id, className, children }: Props) {
  const child = Children.only(children);
  const own = isValidElement(child) ? child.props : {};
  const fieldId = id ?? own.id ?? (own.name ? `field-${own.name}` : undefined);
  const hintId = hint && fieldId ? `${fieldId}-hint` : undefined;
  const errorId = error && fieldId ? `${fieldId}-error` : undefined;
  const describedBy = [own['aria-describedby'], hintId, errorId].filter(Boolean).join(' ') || undefined;

  const control = cloneElement(child, {
    id: fieldId,
    required: required ?? own.required,
    'aria-invalid': error ? true : own['aria-invalid'],
    'aria-describedby': describedBy,
  });

  return (
    <div className={cn('k-field', className)}>
      <label htmlFor={fieldId} className="k-field__label">
        {label}
        {required && (
          <span className="k-field__req" aria-hidden="true">
            *
          </span>
        )}
        {!required && optionalLabel && <span className="k-field__optional">{optionalLabel}</span>}
      </label>
      {control}
      {hint && (
        <p id={hintId} className="k-field__hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="k-field__error">
          <CircleAlert aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
