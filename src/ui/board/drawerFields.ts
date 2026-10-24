// Поля в шторке лида (pipeline-v2 §9.6, ui-polish §9.7): из карточки клиента `GET /api/clients/[id]` берутся поля клиента и
// карточки, которые показываются на плитке (`showOn.kanban`, идут первыми) и на карточке (`showOn.card`). Правка на месте — только при праве `edit` у роли и права на объект,
// только для типов, которые вводятся одним элементом, и при включённом CALLBACK_V2 (режим «одно поле»).
import type { ClientCardDto } from '@/server/domain/clients';
import type { CardFieldLabel } from '@/ui/call/types';

/** Типы, которые правятся на месте (datetime и user выбираются другими экранами). */
const EDITABLE_TYPES: ReadonlySet<string> = new Set(['text', 'textarea', 'email', 'url', 'phone', 'number', 'money', 'date', 'boolean', 'select', 'multiselect']);
/** Сколько полей видно сразу; остальные раскрываются на месте («Ещё N полей»), а не отрезаются молча. */
export const FIRST_ROWS = 6;

export interface DrawerRow {
  field: CardFieldLabel;
  value: unknown;
}

export function drawerRows(dto: Pick<ClientCardDto, 'fields' | 'card' | 'can'>, inlineEdit: boolean): DrawerRow[] {
  const rows: Array<DrawerRow & { kanban: boolean }> = [];
  const add = (object: 'client' | 'card', fields: ClientCardDto['fields']['fields'], canObject: boolean) => {
    for (const f of fields) {
      if ((!f.showOn.card && !f.showOn.kanban) || f.archived) continue;
      const editable = inlineEdit && canObject && f.access === 'edit' && EDITABLE_TYPES.has(f.type);
      rows.push({
        kanban: f.showOn.kanban,
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
  // Пустые поля без права правки показывать незачем; поля плитки — первыми (порядок внутри групп сохраняется)
  const shown = rows.filter((r) => r.field.editable || !(r.value === null || r.value === '' || (Array.isArray(r.value) && r.value.length === 0)));
  return [...shown.filter((r) => r.kanban), ...shown.filter((r) => !r.kanban)].map(({ field, value }) => ({ field, value }));
}

/** Первые `limit` полей и остаток: ни одно поле не теряется, остаток раскрывается кнопкой «Ещё N полей». */
export function splitRows<T>(rows: readonly T[], limit = FIRST_ROWS): { first: T[]; rest: T[] } {
  return { first: rows.slice(0, limit), rest: rows.slice(limit) };
}
