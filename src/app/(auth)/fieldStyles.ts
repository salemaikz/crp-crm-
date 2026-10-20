// Общие классы полей и кнопок экранов входа: высота не меньше 44 px, шрифт 16 px (iOS не приближает поле).
export const inputClass =
  'block min-h-11 w-full rounded-lg border border-neutral-300 bg-white px-3 text-base text-neutral-900 outline-none focus:border-neutral-900 focus:ring-2 focus:ring-neutral-900/20';
export const buttonClass =
  'min-h-11 w-full rounded-lg bg-neutral-900 px-4 text-base font-medium text-white disabled:cursor-not-allowed disabled:opacity-50';
export const ghostButtonClass =
  'min-h-11 w-full rounded-lg border border-neutral-300 bg-white px-4 text-base font-medium text-neutral-900 disabled:opacity-50';
export const errorClass = 'rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800';
