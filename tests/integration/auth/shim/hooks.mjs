// Хук разрешения модулей для тестов cookie сессии вне Next: next/headers → записывающая подмена.
// Регистрируется из теста до загрузки src/** (node:module register).
const NEXT_HEADERS = new URL('./nextHeaders.ts', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'next/headers') return nextResolve(NEXT_HEADERS, context);
  return nextResolve(specifier, context);
}
