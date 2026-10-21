// Прогон изоляции на Postgres 16 (TEST_DATABASE_URL): npm run test:isolation. Обвязка — tests/isolation/runner,
// каркас синтетики — tests/isolation/harness. Новые модули добавляют только манифест tests/isolation/manifest/<модуль>.ts.
//
// Хуки регистрируются ДО загрузки src/**: next-intl/server (react-server), next-intl/config, next/headers. Поэтому у файла
// нет статических импортов проекта — всё, что тянет src, грузится динамически ниже.
import { register } from 'node:module';

register('./runner/hooks.mjs', import.meta.url);

// Функции за флагами проверяются включёнными: выключенный флаг отвечает 404 всем, это не проверка изоляции.
// Выключенное состояние покрывают интеграционные тесты модулей (например, consult-routes.test.ts).
process.env['FEATURE_BK_WIZARD'] ??= '1';
process.env['FEATURE_PURCHASES'] ??= '1';

const { defineIsolationRun } = await import('./runner/main');
await defineIsolationRun();
