// Общие классы полей и кнопок экранов входа: высота не меньше 44 px, шрифт 16 px (iOS не приближает поле).
// Цвета — только токены темы, иначе на тёмной теме поля остаются белыми.
export const inputClass =
  'block min-h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base text-ink outline-none focus:border-brand-ink focus:ring-2 focus:ring-brand-ink/25';
export const buttonClass =
  'min-h-11 w-full rounded-lg bg-ink px-4 text-base font-medium text-surface disabled:cursor-not-allowed disabled:opacity-50';
export const ghostButtonClass =
  'min-h-11 w-full rounded-lg border border-line-strong bg-surface px-4 text-base font-medium text-ink disabled:opacity-50';
export const errorClass = 'rounded-lg bg-danger-tint px-3 py-2 text-sm text-danger';
