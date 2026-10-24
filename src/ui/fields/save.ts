// Итог сохранения одного поля на месте (pipeline-v2 §9.6, D-356). Тип общий для InlineField и тех, кто шлёт запрос
// (карточка клиента, шторка, карточка обзвона): компонент не знает адресов и протокола.
export type FieldSave =
  | { ok: true }
  | { ok: false; kind: 'conflict'; current: unknown; known: boolean }
  | { ok: false; kind: 'fields'; code?: string }
  | { ok: false; kind: 'forbidden' | 'readonly' | 'invalid' | 'network' };
