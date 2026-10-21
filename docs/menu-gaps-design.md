# Пункты меню без страниц: «Мой день», «Карточки», «Пул» (D-313)

Статус: дизайн architect, решение D-313 «предложено». Код не написан.

## 1. Проблема

В каталоге `src/ui/shells/menu.ts` три адреса без `page.tsx` — пункт меню ведёт на 404.

| Пункт | Оболочка | Условие | Кому виден в пресетах |
|---|---|---|---|
| `myDay` → `/my-day` | operator | ключ `my_day`, `card.read` | crp `operator`, base `manager` |
| `myDay` → `/my-day` | consultant | ключ `my_day`, `booking.read` (даёт отношение `booked_with_me`) | crp `consultant` |
| `cards` → `/cards` | manager | ключ `cards`, `card.read` | crp `rop`, `director`; base `lead`, `observer` |
| `pool` → `/pool` | manager | ключ `pool`, `pool.read` | crp `rop`, base `lead` |

Все остальные адреса каталога страницы имеют (сверено с `src/app/**/page.tsx`).

## 2. Решение: убрать три пункта. Новых страниц, SQL и данных нет

| Пункт | Что делаем | Где роль это уже видит |
|---|---|---|
| «Мой день» оператора | убрать из каталога | Строка `call-today` на «Звонить» (`/call`, главная оператора): итоги, дозвоны, записи и пропуски X из лимита из `GET /api/calls/today` с поправкой на неотправленные. Это ровно PROCESS §10.2 «3 числа; пропуски X из 10» |
| «Мой день» консультанта | убрать из каталога | `/consultations`: группы «Сегодня / Завтра / Позже / Не отмечены» по своим записям в окне (D-246). PROCESS §8.2 «отчёты: свои БК» этим экраном и закрывается, отдельного отчёта нет |
| «Карточки» | убрать из каталога | «Клиенты» (`/clients`) в той же оболочке: тот же охват `space`, фильтр по состоянию карточки, виды «Все / Мои / Архив». Карточка обзвона и клиент в пространстве — одна строка списка |
| «Пул» | слить с «Раздачей» | `/distribution`: первая вкладка «Пул» (`PoolPanel`, `GET /api/distribution/pool`), «Предложены», «Без владельца»; «Дубли» — `/pairs`. Страница охраняется `pool.read` |

Правка пункта «Раздача»: `{ id: 'distribution', href: '/distribution', keys: ['distribution', 'pool'], perm: 'pool.read' }`.
Право пункта становится равным праву страницы (сейчас `distribution.manage`, а страница проверяет `pool.read`).
Роль с `pool.read` без `distribution.manage` видит экран без кнопок управления — экран это уже умеет (`canManage`,
`canIssue`). Пункт `transfer` по-прежнему включается ключом `distribution`.

Охваты не меняются: ни одного нового запроса, маршрута или поля в ответах.

### Отвергли

- **Отдельные страницы `/my-day`, `/cards`, `/pool` поверх существующих сервисов.** Все три дублируют экраны,
  которые та же роль уже видит в меню. Второй экран с теми же данными нужно держать в манифесте изоляции,
  e2e и локалях, а пользы он не даёт. «Мой день» оператора как отдельный экран уводит с «Звонить», где числа и так
  перед глазами.
- **Страницы-перенаправления** (`/my-day` → `/call`, `/cards` → `/clients`, `/pool` → `/distribution`). Дают два
  пункта меню на один экран и подсветку не того пункта. Закладок на эти адреса нет: они всегда были 404.

## 3. Где правки

| Файл | Правка | Поток |
|---|---|---|
| `src/ui/shells/menu.ts` | убрать `myDay` (обе оболочки), `cards`, `pool` из каталога и `MenuId`; правка `distribution` (§2); экспорт `MENU_KEYS` — множество ключей `keys` каталога | platform (оболочки) |
| `src/ui/shells/ShellNav.tsx` | убрать иконки `myDay`, `cards`, `pool` | platform |
| `messages/ru/shell.json` | убрать `nav.myDay`, `nav.cards`, `nav.pool` | platform |
| `presets/clients/crp/preset.json`, `presets/base/preset.json` | убрать ключи `my_day` и `cards` из `roles[].menu`; `pool` оставить (включает «Раздачу»). `grants` не трогаем | platform (`presets/**`) |
| `docs/PROCESS.md` §10.2 | строка «Мой день»: где показывается (сделано этим коммитом) | architect |
| `docs/reports-plugins-design.md` §1.5 | «другой экран» → «строка на «Звонить» и `/consultations` (D-313)» | manager |

Уже установленные настройки со старыми ключами `my_day`, `cards` работают: неизвестный ключ меню просто ничего не
включает. Миграция настроек не нужна.

Манифест изоляции: новых страниц и маршрутов нет, правок нет. Тексты: только удаление трёх ключей.

## 4. Тесты

1. `tests/unit/ui/shells.test.ts` — новые снимки:
   - operator / base manager: `/call, /clients, /tasks, /bookings, /archive` (у base manager без `/archive`);
   - consultant: `/consultations, /tasks` (главная `/consultations`; при выключенном `BK_WIZARD` — `/tasks`);
   - rop / lead: `/summary, /distribution, /clients, /bookings, /deals, /reports, /settings, /tasks, /import`;
   - director / observer: `/director, /clients, /deals, /reports, /reports/exports`;
   - тест «РОП: восемь основных пунктов» → `summary, distribution, clients, bookings, kanban, reports, settings, tasks`.
2. **Новый** `tests/unit/ui/menu-pages.test.ts` (страж, чтобы дыра не вернулась):
   - каждый `href` каталога есть среди страниц манифеста изоляции (`kind: 'page'`, путь без группы маршрутов);
   - для каждой роли пресетов `base` и `clients/crp` и наборов флагов «все включены» / «все выключены»: у каждого
     видимого пункта право страницы из манифеста проходит `can(viewer, perm)` (кроме `authenticated`/`public` и
     пунктов `adminOnly`/`orAdmin` под администратором). Это ловит и расхождения прав пункта и страницы. Сейчас
     `archive` (`card.read` у пункта, `client.read` у страницы) не роняет тест на пресетах, но правку права пункта
     на `client.read` сделать в той же задаче;
   - каждый ключ `roles[].menu` пресетов входит в `MENU_KEYS` или в ключи выбора оболочки (`queue`,
     `consultations`) — мёртвых ключей в пресетах нет.
3. e2e `tests/e2e/shell-menu.spec.ts` (мобильный размер для operator и consultant, ноутбук для rop): войти ролью,
   пройти все пункты меню и «Ещё», у каждого ответ < 400 и нет текста страницы 404. Хелперы — `makeOperator`,
   `makeConsultant` из `tests/e2e/support`; РОП — по образцу `reports-summary.spec.ts`.

## 5. Задачи

| # | Задача | Уровень | Поток | Исполнитель |
|---|---|---|---|---|
| 1 | Правки `menu.ts`, `ShellNav.tsx`, `shell.json`; снимки `shells.test.ts`; право `archive` → `client.read` | T1 | platform | builder |
| 2 | Ключи `my_day`, `cards` из `roles[].menu` пресетов crp и base (без `grants`) | T0 | platform | mechanic |
| 3 | Страж `menu-pages.test.ts` (§4.2) | T1 | platform | tester |
| 4 | e2e `shell-menu.spec.ts` (§4.3) | T1 | platform | tester |
| 5 | Строка §1.5 в `docs/reports-plugins-design.md` | T0 | manager | mechanic |
| 6 | Ревью 1–5 перед пушем | T2 | — | reviewer |

Порядок: 1 и 2 одним PR (снимки зависят от обоих), затем 3 и 4 параллельно, 5 — отдельно.
