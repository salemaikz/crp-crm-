import type { HTMLAttributes, ReactNode } from 'react';
import Link from 'next/link';
import { cn } from './cn';

/** Список записей (клиенты, задачи, звонки). Строка — не меньше 44 px по высоте. */
export function List({ className, children, ...rest }: HTMLAttributes<HTMLUListElement>) {
  return (
    <ul className={cn('k-list', className)} {...rest}>
      {children}
    </ul>
  );
}

type ItemProps = {
  title: ReactNode;
  /** Вторая строка: ЛПР, город, последний итог. */
  meta?: ReactNode;
  /** Слева: аватар, значок. */
  leading?: ReactNode;
  /** Справа: бейдж состояния, время. */
  trailing?: ReactNode;
  /** Строка-ссылка. */
  href?: string;
  /** Строка-кнопка (если нет href). */
  onClick?: () => void;
  /** Текущая строка. */
  selected?: boolean;
  className?: string;
};

/** Строка списка: заголовок, мета, бейдж. Кликабельна целиком (ссылка или кнопка). */
export function ListItem({ title, meta, leading, trailing, href, onClick, selected, className }: ItemProps) {
  const content = (
    <>
      {leading && <span className="k-list__lead">{leading}</span>}
      <span className="k-list__main">
        <span className="k-list__title">{title}</span>
        {meta && <span className="k-list__meta">{meta}</span>}
      </span>
      {trailing && <span className="k-list__trail">{trailing}</span>}
    </>
  );
  const cls = cn('k-list__row', className);
  return (
    <li className="k-list__item" aria-current={selected ? 'true' : undefined}>
      {href ? (
        <Link href={href} className={cls}>
          {content}
        </Link>
      ) : onClick ? (
        <button type="button" className={cls} onClick={onClick}>
          {content}
        </button>
      ) : (
        <div className={cls}>{content}</div>
      )}
    </li>
  );
}
