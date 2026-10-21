// Источник: платформа LMS 2cd8a2b src/components/ui/Table.tsx (адаптировано под CRM)
import type { ReactNode } from 'react';
import { cn } from './cn';

export type TableColumn<T> = {
  key: string;
  header: ReactNode;
  /** Подпись в мобильной карточке (если header — не строка). */
  mobileLabel?: string;
  cell: (row: T, index: number) => ReactNode;
  align?: 'left' | 'right' | 'center';
  /** Число или сумма: правый край, tabular-nums, без переносов (в th и td). */
  numeric?: boolean;
  /** Телефон, дата, имя: не переносится. */
  nowrap?: boolean;
  /** Ширина колонки (CSS), например '30%' или '120px'. */
  width?: string;
  /** Главная ячейка: на телефоне — заголовок карточки, без подписи. */
  primary?: boolean;
  /** Скрыть на телефоне. */
  hideOnMobile?: boolean;
};

type Props<T> = {
  columns: TableColumn<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  caption?: ReactNode;
  /** Что показать, если строк нет. */
  empty?: ReactNode;
  /** На телефоне превращать строки в карточки (по умолчанию да). */
  stackOnMobile?: boolean;
  dense?: boolean;
  /** Строка «Итого» внизу: жирно, рамка сверху. Ячейки по числу колонок. */
  footer?: ReactNode[];
  /** Первая колонка липкая при горизонтальной прокрутке. */
  stickyFirst?: boolean;
  /** Подпись только для скринридера: таблица стоит под заголовком раздела и не повторяет его. */
  captionHidden?: boolean;
  className?: string;
};

/** Таблица на «бумаге»; на узком экране строки становятся карточками с подписями. */
export function Table<T>({
  columns,
  rows,
  rowKey,
  caption,
  empty,
  stackOnMobile = true,
  dense,
  footer,
  stickyFirst,
  captionHidden,
  className,
}: Props<T>) {
  return (
    <div className={cn('k-table-wrap', stackOnMobile && 'k-table--stack', className)}>
      <table className={cn('k-table', dense && 'k-table--dense', stickyFirst && 'k-table--sticky-first')}>
        {caption && <caption className={captionHidden ? 'k-visually-hidden' : undefined}>{caption}</caption>}
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" data-align={c.numeric ? 'right' : c.align} data-numeric={c.numeric ? '' : undefined} data-nowrap={c.nowrap ? '' : undefined} style={c.width ? { width: c.width } : undefined}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="k-table__empty" data-label="">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row, i) => (
              <tr key={rowKey(row, i)}>
                {columns.map((c) => (
                  <td
                    key={c.key}
                    data-align={c.numeric ? 'right' : c.align}
                    data-numeric={c.numeric ? '' : undefined}
                    data-nowrap={c.nowrap ? '' : undefined}
                    data-label={c.mobileLabel ?? (typeof c.header === 'string' ? c.header : '')}
                    data-primary={c.primary ? '' : undefined}
                    data-mobile-hidden={c.hideOnMobile ? '' : undefined}
                  >
                    {c.cell(row, i)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
        {footer && rows.length > 0 && (
          <tfoot>
            <tr>
              {columns.map((c, i) => (
                <td key={c.key} data-align={c.numeric ? 'right' : c.align} data-numeric={c.numeric ? '' : undefined} data-nowrap={c.nowrap ? '' : undefined} data-label={typeof c.header === 'string' ? c.header : ''}>
                  {footer[i]}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
