// Поля клиента и карточки из ячеек таблицы по fieldTargets профиля (дизайн C4d §4, §7.2): значение
// приводится к типу поля движком K2 (D-051); не подошло — поле остаётся пустым, строка не отбрасывается.
import { fields, type phone } from '@crm/core';
import type { FieldTarget } from './types';

function rawFor(def: fields.FieldDef, text: string): unknown {
  const t = text.trim();
  switch (def.type) {
    case 'select': {
      const low = t.toLowerCase();
      const o = def.options.find((x) => !x.archived && (x.key.toLowerCase() === low || x.label.ru.trim().toLowerCase() === low));
      return o?.key ?? '';
    }
    case 'number':
    case 'money': {
      const n = Number(t.replace(/\s+/g, '').replace(',', '.'));
      return t !== '' && Number.isFinite(n) ? n : '';
    }
    case 'multiselect':
    case 'datetime':
      return '';
    default:
      return t;
  }
}

/** Значения полей объекта (`client` или `card`) из разобранных ячеек строки. */
export function customFromRow(
  rowFields: Readonly<Record<string, string>>,
  targets: Readonly<Record<string, FieldTarget>>,
  object: 'client' | 'card',
  defs: readonly fields.FieldDef[],
  phoneRules: phone.PhoneRules,
): Record<string, fields.FieldValue> {
  const out: Record<string, fields.FieldValue> = {};
  for (const [importField, target] of Object.entries(targets)) {
    if (target.object !== object) continue;
    const text = rowFields[importField];
    if (!text) continue;
    const def = defs.find((d) => d.key === target.fieldKey && d.object === object && !d.archived);
    if (!def) continue;
    const r = fields.coerceValue(def, rawFor(def, text), { phoneRules });
    if (r.ok && r.value !== null) out[def.key] = r.value;
  }
  return out;
}
