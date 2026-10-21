import type { ReactNode } from 'react';
import { cn } from './cn';

export type DataListItem = { label: ReactNode; value?: ReactNode; key?: string };

function isEmpty(v: ReactNode): boolean {
  return v === undefined || v === null || v === false || v === '';
}

/** Пары «подпись — значение»: подписи в одной колонке, значения на одной вертикали, пустое — «—». */
export function DataList({ items, className, ...rest }: { items: readonly DataListItem[]; className?: string } & Record<string, unknown>) {
  return (
    <dl className={cn('k-datalist', className)} {...rest}>
      {items.map((it, i) => (
        <div key={it.key ?? i} className="contents">
          <dt>{it.label}</dt>
          <dd>{isEmpty(it.value) ? <span className="k-datalist__empty">—</span> : it.value}</dd>
        </div>
      ))}
    </dl>
  );
}
