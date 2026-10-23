// Поля в шторке лида (pipeline-v2 §9.6): из карточки клиента `GET /api/clients/[id]` берутся поля клиента и карточки,
// которые показываются на карточке (`showOn.card`). Правка на месте — только при праве `edit` у роли и права на объект,
// только для типов, которые вводятся одним элементом, и при включённом CALLBACK_V2 (режим «одно поле»).
import type { ClientCardDto } from '@/server/domain/clients';
import type { CardFieldLabel } from '@/ui/call/types';

/** Типы, которые правятся на месте (datetime и user выбираются другими экранами). */
const EDITABLE_TYPES: ReadonlySet<string> = new Set(['text', 'textarea', 'email', 'url', 'phone', 'number', 'money', 'date', 'boolean', 'select', 'multiselect']);
const MAX_ROWS = 6;

export interface DrawerRow {
  field: CardFieldLabel;
  value: unknown;
}

export function drawerRows(dto: Pick<ClientCardDto, 'fields' | 'card' | 'can'>, inlineEdit: boolean): DrawerRow[] {
  const rows: DrawerRow[] = [];
  const add = (object: 'client' | 'card', fields: ClientCardDto['fields']['fields'], canObject: boolean) => {
    for (const f of fields) {
      if (!f.showOn.card || f.archived) continue;
      const editable = inlineEdit && canObject && f.access === 'edit' && EDITABLE_TYPES.has(f.type);
      rows.push({
        field: {
          key: f.key,
          label: f.label.ru,
          options: Object.fromEntries(f.options.map((o) => [o.key, o.label.ru])),
          object,
          type: f.type,
          editable,
          choices: f.options.filter((o) => !o.archived).map((o) => ({ key: o.key, label: o.label.ru })),
        },
        value: f.value,
      });
    }
  };
  add('card', dto.card?.fields.fields ?? [], dto.can.editCard);
  add('client', dto.fields.fields, dto.can.edit);
  // Пустые поля без права правки показывать незачем
  return rows.filter((r) => r.field.editable || !(r.value === null || r.value === '' || (Array.isArray(r.value) && r.value.length === 0))).slice(0, MAX_ROWS);
}
