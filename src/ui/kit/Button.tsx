// Источник: платформа LMS 2cd8a2b src/components/ui/Button.tsx (адаптировано под CRM)
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';
import Link from 'next/link';
import { cn } from './cn';
import { isExternalHref } from './href';

/**
 * primary — ГЛАВНОЕ действие экрана: на экране она одна (правило минимализма). Остальные действия —
 * secondary (обводка) или quiet (текстовая). danger — необратимое действие, только вторым шагом.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';
/** Все размеры не ниже цели нажатия 44 px. lg — крупные кнопки итога звонка. */
export type ButtonSize = 'sm' | 'md' | 'lg';

type BaseProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** На всю ширину контейнера. */
  block?: boolean;
  /** Только иконка (обязателен aria-label). */
  iconOnly?: boolean;
  className?: string;
  children?: ReactNode;
};

export type ButtonAsButton = BaseProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'> & { href?: undefined };

export type ButtonAsLink = BaseProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'className' | 'children' | 'href'> & {
    /** Путь приложения ('/calling'); http/mailto/tel/якорь — обычная ссылка. */
    href: string;
    /** Принудительно обычный <a> (скачивание, tel: и т. п.). */
    external?: boolean;
    prefetch?: boolean;
  };

export type ButtonProps = ButtonAsButton | ButtonAsLink;

/** Классы кнопки — для своих элементов (например, <summary> или чужого Link). */
export function buttonClass({
  variant = 'primary',
  size = 'md',
  block,
  iconOnly,
  className,
}: Pick<BaseProps, 'variant' | 'size' | 'block' | 'iconOnly' | 'className'> = {}): string {
  return cn(
    'k-btn',
    `k-btn--${variant}`,
    size !== 'md' && `k-btn--${size}`,
    block && 'k-btn--block',
    iconOnly && 'k-btn--icon',
    className,
  );
}

function isLink(props: ButtonProps): props is ButtonAsLink {
  return typeof props.href === 'string';
}

/** Кнопка. С href рендерит ссылку (внутреннюю — через next/link). */
export function Button(props: ButtonProps) {
  if (isLink(props)) {
    const { variant, size, block, iconOnly, className, children, href, external, prefetch, ...rest } = props;
    const cls = buttonClass({ variant, size, block, iconOnly, className });
    if (external || isExternalHref(href)) {
      return (
        <a href={href} className={cls} {...rest}>
          {children}
        </a>
      );
    }
    return (
      <Link href={href} prefetch={prefetch} className={cls} {...rest}>
        {children}
      </Link>
    );
  }
  const { variant, size, block, iconOnly, className, children, type = 'button', ...rest } = props;
  return (
    <button type={type} className={buttonClass({ variant, size, block, iconOnly, className })} {...rest}>
      {children}
    </button>
  );
}
