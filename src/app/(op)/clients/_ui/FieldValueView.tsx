'use client';

import { formatDay, formatNumber, labelOf } from './format';
import type { FieldView } from './types';

/** Значение поля настроек для показа. Ссылка и почта — только готовый href из DTO. */
export function FieldValueView({ f, yes, no }: { f: FieldView; yes: string; no: string }) {
  const v = f.value;
  if (v === null) return <span className="text-[var(--text-2)]">—</span>;
  const optionLabel = (key: string) => {
    const o = f.options.find((x) => x.key === key);
    return o ? labelOf(o.label) : key;
  };
  switch (f.type) {
    case 'boolean':
      return <>{v === true ? yes : no}</>;
    case 'select':
      return <>{optionLabel(String(v))}</>;
    case 'multiselect':
      return <>{(Array.isArray(v) ? v : []).map(optionLabel).join(', ')}</>;
    case 'money':
      return <>{typeof v === 'number' ? `${formatNumber(v)} ₸` : String(v)}</>;
    case 'number':
      return <>{typeof v === 'number' ? formatNumber(v) : String(v)}</>;
    case 'date':
      return <>{formatDay(String(v))}</>;
    case 'url':
    case 'email':
      return f.href ? (
        <a className="k-link" href={f.href} {...(f.type === 'url' ? { target: '_blank', rel: 'noopener noreferrer' } : { rel: 'noopener noreferrer' })}>
          {String(v)}
        </a>
      ) : (
        <>{String(v)}</>
      );
    default:
      return <>{String(v)}</>;
  }
}
