import next from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

// Слои кода (D-011, docs/ARCHITECTURE.md §2.1). Дублируются статическим тестом tests/unit/layers.test.ts,
// который ещё понимает 'use client' и обход относительных импортов.
const NEXT = ['next', 'next/*', 'next-intl', 'next-intl/*'];
const REACT = ['react', 'react/*', 'react-dom', 'react-dom/*'];
const FS = ['fs', 'fs/*', 'node:fs', 'node:fs/*'];
const SYSTEM_ACTOR = '@/server/access/systemActor';

const restrict = (paths, patterns) => ({
  '@typescript-eslint/no-restricted-imports': ['error', { paths, patterns }],
});
const msg = (group, message, allowTypeImports = false) => ({ group, message, allowTypeImports });

const config = [
  ...next,
  ...nextTs,
  {
    ignores: ['.next/**', 'node_modules/**', 'docs/**', '.claude/**', 'dist/**', 'playwright-report/**', 'test-results/**'],
  },
  // Ядро: только себя и zod
  {
    files: ['packages/core/**/*.{ts,tsx}'],
    rules: restrict(
      [{ name: 'postgres', message: 'Ядро чистое: без БД.' }],
      [
        msg([...NEXT, ...REACT, ...FS], 'Ядро чистое: без Next, React и ФС.'),
        msg(['@/*', '**/src/server/**', '**/src/app/**', '**/src/ui/**', '**/src/integrations/**'], 'Ядро не импортирует src/**.'),
      ],
    ),
  },
  // Платформа сервера: без Next (кроме platform/http), домена, интеграций, интерфейса
  {
    files: ['src/server/platform/**/*.{ts,tsx}'],
    ignores: ['src/server/platform/http/**'],
    rules: restrict(
      [],
      [msg(NEXT, 'Платформа без Next (кроме src/server/platform/http/).'), msg(['@/server/domain', '@/server/domain/*', '@/integrations', '@/integrations/*', '@/app/*', '@/ui', '@/ui/*'], 'Платформа не импортирует домен, интеграции и интерфейс.')],
    ),
  },
  // Домен: без Next, интерфейса и конкретных плагинов (контракт можно); SystemActor — только типом
  {
    files: ['src/server/domain/**/*.{ts,tsx}'],
    rules: restrict(
      [],
      [
        msg(NEXT, 'Домен без Next.'),
        msg(['@/app/*', '@/ui', '@/ui/*'], 'Домен не импортирует интерфейс.'),
        msg(['@/integrations/*', '!@/integrations/contract'], 'Домен видит только интерфейсы @/integrations/contract.'),
        msg([SYSTEM_ACTOR], 'SystemActor — только в scripts/** и src/server/jobs/**; в репозитории допустим импорт типа.', true),
      ],
    ),
  },
  // Доступ: ядро и платформа
  {
    files: ['src/server/access/**/*.{ts,tsx}'],
    rules: restrict([], [msg(['@/app/*', '@/ui', '@/ui/*', '@/integrations', '@/integrations/*'], 'Доступ не импортирует интерфейс и интеграции.')]),
  },
  // Интеграции: ядро и платформа; друг друга и домен — нельзя
  {
    files: ['src/integrations/**/*.{ts,tsx}'],
    rules: restrict([], [
      msg(['@/server/domain', '@/server/domain/*', '@/app/*', '@/ui', '@/ui/*'], 'Интеграции не импортируют домен и интерфейс.'),
      msg([SYSTEM_ACTOR], 'SystemActor недоступен интеграциям.'),
    ]),
  },
  {
    files: ['src/integrations/telephony/**/*.{ts,tsx}'],
    rules: restrict([], [msg(['@/integrations/messenger/*', '@/integrations/messenger'], 'Плагины не импортируют друг друга.')]),
  },
  {
    files: ['src/integrations/messenger/**/*.{ts,tsx}'],
    rules: restrict([], [msg(['@/integrations/telephony/*', '@/integrations/telephony'], 'Плагины не импортируют друг друга.')]),
  },
  // Интерфейс: SQL и охват запросов — только через домен и доступ; SystemActor недоступен
  {
    files: ['src/app/**/*.{ts,tsx}', 'src/ui/**/*.{ts,tsx}'],
    rules: restrict(
      [{ name: 'postgres', message: 'SQL — только в репозиториях домена.' }],
      [
        msg(['@/server/platform/db', '@/server/platform/db/*'], 'Интерфейс не работает с БД напрямую.'),
        msg(['@/server/domain/*/repo', '@/server/access/scope'], 'Репозитории и scopeSql — только для домена и доступа.'),
        msg([SYSTEM_ACTOR], 'SystemActor недоступен в src/app и src/ui.'),
      ],
    ),
  },
  // Только src/server/access выдаёт запросы с охватом: scopeSql не импортируют ни скрипты, ни воркер
  {
    files: ['scripts/**/*.ts'],
    rules: restrict([], [msg(['@/server/access/scope', '@/server/domain/*/repo'], 'Скрипты ходят в данные через домен и SystemActor.')]),
  },
];

export default config;
