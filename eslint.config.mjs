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

// Внутренности доступа: подмена сессии/часов для тестов, сырые SQL-фрагменты охвата, реестр выданных исполнителей.
// В src/** (кроме самого src/server/access) их импортировать нельзя — только тесты (дублирует tests/unit/layers.test.ts).
const ACCESS_INTERNALS = msg(
  ['@/server/access/testing', '@/server/access/sqlFrag', '@/server/access/registry', '**/access/testing', '**/access/sqlFrag', '**/access/registry'],
  'access/testing, access/sqlFrag и access/registry — внутренности доступа: тесты и сам src/server/access.',
);
// Сборка Viewer в обход buildViewer(): регистрирует исполнителя любой формы (в т.ч. поддельный system).
const ASSEMBLE_VIEWER = {
  group: ['@/server/access/viewer', '**/access/viewer'],
  importNames: ['assembleViewer'],
  message: 'assembleViewer — только src/server/access и тесты: исполнитель выдаётся buildViewer()/systemActor().',
};
// restrict для файлов src/** вне src/server/access: общие запреты блока + запрет внутренностей доступа
const restrictSrc = (paths, patterns) => restrict(paths, [...patterns, ACCESS_INTERNALS, ASSEMBLE_VIEWER]);

const INTEGRATION_PATTERNS = [
  msg(['@/server/domain', '@/server/domain/*', '@/app/*', '@/ui', '@/ui/*'], 'Интеграции не импортируют домен и интерфейс.'),
  msg([SYSTEM_ACTOR], 'SystemActor недоступен интеграциям.'),
];

const POSTGRES_PATH = { name: 'postgres', message: 'SQL — только в репозиториях домена.' };
const UI_PATTERNS = [
  msg(['@/server/platform/db', '@/server/platform/db/*'], 'Интерфейс не работает с БД напрямую.'),
  msg(['@/server/domain/*/repo', '@/server/access/scope'], 'Репозитории и scopeSql — только для домена и доступа.'),
  msg([SYSTEM_ACTOR], 'SystemActor недоступен в src/app и src/ui.'),
];
// Как звонить и писать решает сервер (D-268): интерфейс берёт ссылку из dialAction()/chatAction(), а не строит сам.
// Дублирует tests/unit/layers.test.ts (там же — относительные пути).
const CHANNEL_LINK_FILES = ['src/ui/call/dial.ts', 'src/ui/messenger/openChat.ts'];
const CHANNEL_LINK_MESSAGE = 'tel: и wa.me — через dialAction() (src/ui/call/dial.ts) и chatAction() (src/ui/messenger/openChat.ts).';
const CHANNEL_LINK_PATHS = [
  { name: '@/shared/tel', importNames: ['telHref'], message: CHANNEL_LINK_MESSAGE },
  { name: '@/shared/whatsapp', importNames: ['waHref'], message: CHANNEL_LINK_MESSAGE },
];

const config = [
  ...next,
  ...nextTs,
  {
    ignores: ['.next/**', 'node_modules/**', 'docs/**', '.claude/**', 'dist/**', 'packages/core/dist/**', 'playwright-report/**', 'test-results/**'],
  },
  // Остальной src/** (i18n, shared, proxy, platform/http): внутренности доступа закрыты; дальше блоки слоёв повторяют запрет
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/server/access/**'],
    rules: restrictSrc([], []),
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
    rules: restrictSrc(
      [],
      [msg(NEXT, 'Платформа без Next (кроме src/server/platform/http/).'), msg(['@/server/domain', '@/server/domain/*', '@/integrations', '@/integrations/*', '@/app/*', '@/ui', '@/ui/*'], 'Платформа не импортирует домен, интеграции и интерфейс.')],
    ),
  },
  // Домен: без Next, интерфейса и конкретных плагинов (контракт можно); SystemActor — только типом
  {
    files: ['src/server/domain/**/*.{ts,tsx}'],
    rules: restrictSrc(
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
  // Интеграции: ядро и платформа; друг друга и домен — нельзя. Flat config не склеивает no-restricted-imports
  // между блоками (последний побеждает), поэтому блоки плагинов собираются из общего списка + своего запрета
  {
    files: ['src/integrations/**/*.{ts,tsx}'],
    rules: restrictSrc([], INTEGRATION_PATTERNS),
  },
  {
    files: ['src/integrations/telephony/**/*.{ts,tsx}'],
    rules: restrictSrc([], [...INTEGRATION_PATTERNS, msg(['@/integrations/messenger/*', '@/integrations/messenger'], 'Плагины не импортируют друг друга.')]),
  },
  {
    files: ['src/integrations/messenger/**/*.{ts,tsx}'],
    rules: restrictSrc([], [...INTEGRATION_PATTERNS, msg(['@/integrations/telephony/*', '@/integrations/telephony'], 'Плагины не импортируют друг друга.')]),
  },
  // Интерфейс: SQL и охват запросов — только через домен и доступ; SystemActor недоступен
  {
    files: ['src/app/**/*.{ts,tsx}', 'src/ui/**/*.{ts,tsx}'],
    rules: restrictSrc([POSTGRES_PATH, ...CHANNEL_LINK_PATHS], UI_PATTERNS),
  },
  // Ссылки tel: и wa.me строят только действия кнопок по режиму каналов (D-268)
  {
    files: CHANNEL_LINK_FILES,
    rules: restrictSrc([POSTGRES_PATH], UI_PATTERNS),
  },
  // Только src/server/access выдаёт запросы с охватом: scopeSql не импортируют ни скрипты, ни воркер
  {
    files: ['scripts/**/*.ts'],
    rules: restrict(
      [],
      [msg(['@/server/access/scope', '@/server/domain/*/repo'], 'Скрипты ходят в данные через домен и SystemActor.'), ACCESS_INTERNALS, ASSEMBLE_VIEWER],
    ),
  },
];

export default config;
