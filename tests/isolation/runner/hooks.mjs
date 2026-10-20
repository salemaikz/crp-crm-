// Хуки разрешения модулей для прогона изоляции вне Next (регистрируются из run.test.ts до загрузки src/**).
// Страницы и обёртки вызываются прямо в процессе теста, поэтому серверные части Next подменяются так:
//  - next-intl/server берётся в сборке react-server (getTranslations на сервере, не клиентская заглушка);
//  - next-intl/config — файл запроса src/i18n/request.ts (в Next это делает плагин next-intl);
//  - next/headers — тестовая подмена с областью запроса (cookies() и headers() вне запроса Next бросают).

const REQUEST_CONFIG = new URL('../../../src/i18n/request.ts', import.meta.url).href;
const NEXT_HEADERS = new URL('./shims/nextHeaders.ts', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'next-intl/config') return nextResolve(REQUEST_CONFIG, context);
  if (specifier === 'next/headers') return nextResolve(NEXT_HEADERS, context);
  if (specifier === 'next-intl/server') {
    return nextResolve(specifier, { ...context, conditions: [...(context.conditions ?? []), 'react-server'] });
  }
  return nextResolve(specifier, context);
}

