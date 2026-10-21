# Логотип клиента в шапке и на входе (UI-3, D-333)

Статус: дизайн architect, решение D-333 «предложено». Отвечает на В-UI-1 (`docs/ui-polish-design.md` §8): владелец
хочет логотип **вместо** текста названия, «так будет лаконичнее». Уточняет D-061 (откуда app берёт ассет) и D-319 п. 7
(что показывает оболочка).

Опора: D-061 (ассеты накладки → том `crm_assets`), D-310 (переход документа на `/api/*`), D-318 (стенд Vercel),
D-054 (лицензия не блокирует), D-191 (v1 расширяется только необязательными ключами), `docs/CONFIG.md` §6.14.

## 1. Что есть и чего не хватает

- `theme.logo` — обязательный `AssetKey` (`packages/core/src/config/schema/v1.ts`). У `presets/base` он тоже задан:
  `logo.svg`, нейтральный квадратный значок 64×64. Поэтому правило «есть `theme.logo` → картинка, нет → текст» не
  работает: базовая установка потеряла бы название и показала бы значок.
- `crmctl config apply` проверяет логотип (`logoExists`) и копирует ассеты всех слоёв в `CRM_ASSETS_DIR`
  (`installAssets`). **Приложение этот каталог не читает**, маршрута отдачи нет, в `deploy/compose/compose.yaml` нет
  тома `crm_assets` и переменной `CRM_ASSETS_DIR` у `app`.
- На стенде Vercel сид копирует ассеты в `$TMPDIR/crm-stand-assets` сборки. Функции этот каталог не видят: у них
  файловая система только для чтения, кроме `/tmp`, а `/tmp` сборки до запуска не доживает.
- Шапка (`src/ui/shells/AppShell.tsx`) показывает `<strong data-testid="shell-brand">{brand}</strong>`, а `brand`
  берётся из `org.productName.ru` (`RoleShell.tsx`). На экране входа бренда нет.

## 2. Решение

### 2.1. Настройка: что показывать — `theme.brandMark`

Новый **необязательный** ключ `theme.brandMark: 'name' | 'logo'`. Если ключа нет, это `'name'`: значение «пустое»
и совпадает с поведением до UI-3, поэтому старые ревизии остаются верными без миграции настроек (правило D-191 для
v1 до выпуска). `CONFIG_SCHEMA_VERSION` не меняется.

| Пресет | `theme.brandMark` | `theme.logo` | Что видно |
|---|---|---|---|
| `base` | `"name"` (явно, D-061: умолчания — в base) | `logo.svg` | текст `org.productName` |
| `clients/crp` | `"logo"` | `crp-logo.svg` | логотип, `alt` = `org.productName` |

`'logo'` без файла (каталог не задан, файла нет, файл не прошёл проверку) работает как `'name'`: показывается текст.
Логотип рядом с текстом не показываем: в шапке либо одно, либо другое.

### 2.2. Откуда app берёт файл

Единственный источник — каталог `CRM_ASSETS_DIR` (том `crm_assets`, D-061). Имя файла — только `theme.logo` из
активных настроек. Из запроса имя не берётся никогда.

| Где | `CRM_ASSETS_DIR` у app | Кто кладёт файл |
|---|---|---|
| Установка (Docker) | `/var/lib/crm/assets`, именованный том `crm_assets`, у `app` смонтирован **только для чтения**; значение задаёт `compose.yaml` | `config apply` в одноразовом контейнере `ctl` (тот же том на запись, D-334, §2.6) |
| Стенд Vercel | `stand-assets` (относительно `process.cwd()`), в бандл функций через `outputFileTracingIncludes` | сид на сборке (`scripts/vercel/build.sh` → `crmctl seed`) |
| Локальное демо, e2e | любой каталог (`scripts/demo/local.sh`: `$DEMO_DIR/assets`; обвязка снимков: свой) | сид |
| Без переменной (dev) | — | логотипа нет, в шапке текст |

Стенд Vercel: оверлей (`src/server/platform/stand/overlay.ts`) в режиме стенда **всегда** ставит
`CRM_ASSETS_DIR=stand-assets`, перекрывая явное значение (как флаги интеграций). Так сборка (сид пишет в
`<корень>/stand-assets`) и функции (читают `/var/task/stand-assets`) смотрят в один и тот же каталог. Каталог в
`.gitignore` и `.dockerignore`. `next.config.ts` под `VERCEL=1` добавляет `'./stand-assets/*'` к уже существующему
`'./migrations/*.sql'`. Тот же приём уже работает для миграций (D-318).

### 2.3. Чтение файла — `src/server/platform/brand/logo.ts`

`readLogo(key: string, env = process.env): Promise<LogoFile | null>`, где
`LogoFile = { bytes: Buffer; contentType: string; hash: string }`.

1. `dir = env.CRM_ASSETS_DIR?.trim()`; пусто → `null`.
2. `key` проходит `ASSET_NAME_RE` и не содержит `..`; расширение — только `.svg` → `image/svg+xml`, `.png` →
   `image/png`, `.webp` → `image/webp` (`.woff2` и прочее → `null`). Путь `path.join(path.resolve(dir), key)`, и
   `path.dirname(file) === path.resolve(dir)`.
3. Чтение — та же функция, что у `installAssets`: `O_NOFOLLOW`, только обычный файл, не больше `ASSET_MAX_BYTES`.
   `readRegular` из `src/server/platform/config/preset-files.ts` экспортируется под именем `readAssetFile`, вторую
   копию не пишем. Ошибки `missing`, `symlink`, `not_file`, `too_big` → `null`. В журнал одна строка без пути
   тома: `[brand] логотип недоступен: <код>`. Её пишем не чаще раза на процесс для одного кода.
4. `hash` — первые 16 hex sha256 содержимого.
5. Кэш в памяти процесса — одна запись `{ file, ino, size, mtimeMs, value }`. На каждый вызов делается `lstat`.
   Если `ino`, `size` и `mtimeMs` совпали, файл заново не читается. `installAssets` пишет через rename, поэтому
   новый файл — это новый `ino`.

`loadBrand(): Promise<{ name: string; logoSrc: string | null }>` (`src/ui/shells/loadBrand.ts`, серверный):
- `name` — `org.productName.ru` из `getActiveConfigOrNull()`, запасной — `common.app.name` (как сейчас в
  `RoleShell`);
- `logoSrc` — `/api/brand/logo?v=<hash>`, только если `theme.brandMark === 'logo'` и `readLogo(theme.logo)` не
  `null`; иначе `null`.

### 2.4. Маршрут `GET /api/brand/logo`

Файл: `src/app/api/brand/logo/route.ts` (зона platform, рядом с `api/{auth,health,device}`).

```ts
export const dynamic = 'force-dynamic';
export const GET = publicRoute({ reason: 'asset', origin: 'check' }, async ({ req }) => logoResponse(req));
```

- `PublicRouteOptions.reason` получает значение `'asset'`: публичный ресурс без данных, нужен до входа.
- Сессию маршрут не читает, лицензию не проверяет (D-054: лицензия логотип не блокирует), cookie не ставит.
- Нет настроек (`getActiveConfigOrNull()` → `null`) или `readLogo` → `null`: `logoResponse`
  (`src/server/platform/brand/response.ts`) сам возвращает `404 {"error":"not_found"}` с `Cache-Control: no-store` —
  то же тело, что у обёртки доступа для «нет такого». `NotFoundError` не бросается: платформа не импортирует слой
  `access` (D-011). Параметр `v` на выбор файла не влияет.
- D-310: `<img>` шлёт `Sec-Fetch-Dest: image`, `Sec-Fetch-Mode: no-cors`, это не переход документа. `publicRoute`
  переход и не отсекает, поэтому `DOWNLOAD_ROUTES` не меняется. Если открыть адрес в адресной строке, покажется
  только картинка под `sandbox`. Это не JSON с данными, от которого защищает D-310. `Content-Disposition` не ставим:
  маршрут не скачивание и в перечень `navigation.ts` не входит.

Заголовки ответа 200 (и те же, кроме `Content-Type`/тела, у 304):

| Заголовок | Значение | Зачем |
|---|---|---|
| `Content-Type` | по расширению (`image/svg+xml` …) | без угадывания |
| `Content-Length` | размер | — |
| `X-Content-Type-Options` | `nosniff` | браузер не переосмысливает тип |
| `Content-Security-Policy` | `default-src 'none'; style-src 'unsafe-inline'; sandbox` | SVG, открытый как документ: без скриптов, без внешних загрузок, отдельное происхождение |
| `Cross-Origin-Resource-Policy` | `same-origin` | чужие сайты не встраивают |
| `ETag` | `"<hash>"` | проверка без тела |
| `Cache-Control` | `?v=` равен текущему `hash` → `public, max-age=31536000, immutable`; иначе → `no-cache` | новый файл → новый адрес в шапке; старый или пустой `v` всегда перепроверяется |

`If-None-Match` (список через запятую, `W/` отбрасывается, `*` совпадает с любым) совпал с `ETag` → `304` без тела. nginx на установке
добавляет свой CSP уровня `server`. Браузер применяет оба, итог не мягче нашего. Повтор `nosniff` безвреден.

### 2.5. Компонент и места показа

`BrandMark` (`src/ui/shells/BrandMark.tsx`, `'use client'`): `{ name: string; logoSrc: string | null; size: 'bar' | 'side' | 'auth' }`.

- `logoSrc === null` → прежняя разметка: `<strong data-testid="shell-brand" className="min-w-0 truncate text-lg">`.
- Иначе `<span data-testid="shell-brand" className="flex min-w-0">` и внутри обычный `<img>`:
  `src={logoSrc} alt={name} decoding="async"`, стиль `height: <h>px; width: auto; max-width: 100%;
  object-fit: contain`. Не `next/image`, не встраивание SVG в разметку, без `dangerouslySetInnerHTML`, без
  `filter`/`mix-blend-mode`/перекраски.
- Ошибка загрузки: `onError` запоминает адрес, который не загрузился (`failedSrc`), и показывается текст `name`
  с тем же `data-testid`; `onLoad` сбрасывает запомненный адрес. Новый адрес (после замены файла сменился `?v=`)
  пробуется снова. Ошибка до гидратации ловится в `useEffect` по `[logoSrc]`: `img.complete && img.naturalWidth === 0`.
  Так телефон без сети на закэшированной оболочке `/call` покажет название, а не битую картинку.

Размеры (высота фиксирована, ширина по пропорции файла):

| Место | Высота | Почему |
|---|---|---|
| Шапка телефона (`aside` в обеих оболочках до `md`) | 28 px | строка 56 px; логотип ЦРП → 134 px |
| Боковая колонка (`md+`) | 28 px | в строке колокольчик: 240 − 2·20 − 12 − 44 = 144 px свободно; при 32 px логотип ЦРП занял бы 153 px |
| Экран входа и приглашения | 40 px | над h1, по его левому краю (D-319: одна вертикаль); логотип ЦРП → 192 px |

Минимальная ширина полного логотипа по брендбуку клиента — 120 px. Её выполняют все три места. Если ширины не
хватает, `max-width` и `object-fit: contain` уменьшают картинку без искажения.

Подключение:
- `RoleShell` вызывает `loadBrand()` вместо своего вычисления `brand`, `AppShell` получает
  `brand: { name, logoSrc }` и рисует `<BrandMark size="bar">` на месте `<strong>`.
- `src/app/(auth)/login/page.tsx` и `src/app/(auth)/invite/page.tsx` рендерят серверный `AuthBrand`
  (`src/ui/shells/AuthBrand.tsx`: `loadBrand()` → `<BrandMark size="auth">`). Он показывается только при
  `logoSrc`: в режиме `'name'` экран входа остаётся как сейчас. Страницы не становятся «страницами с данными»: они
  читают только настройки, как корневой layout. Записи `/(auth)/login` и `/(auth)/invite` (`perm: 'public'`) в
  манифесте уже есть, прогон изоляции проверяет их HTML на утечки.
- `account` логотип не получает: это личный кабинет, а не вход.

Новых строк локали нет: `alt` — это `org.productName` из настроек, запасной — существующий `common.app.name`.
Имени клиента в `src/`, `messages/`, `public/` нет: имя файла и название приходят из пресета.

### 2.6. Установка (зона ops, D-334)

Где на самом деле выполняется `config apply`: **только внутри образа**. Хостовый `crmctl` (`/usr/local/lib/crm/crmctl.mjs`)
запускается без ядра (`build-cli.mjs`), а у БД нет портов наружу, поэтому `config` на хосте не работает. До UI-3e в
`compose.yaml` не было сервиса, который мог бы это сделать, а `crmctl install` пресет не применяет.

- `compose.yaml`: именованный том `crm_assets` (`name: crm_assets`). У `app` он смонтирован
  `crm_assets:/var/lib/crm/assets:ro`, у `worker` и `migrate` не монтируется.
- Новый одноразовый сервис **`ctl`** (профиль `tools`, как `migrate`): тот же образ и `x-app-common` (только чтение
  корня, `cap_drop: ALL`, `no-new-privileges`), `entrypoint: node dist/crmctl.mjs`, сеть только `crm_internal`, том
  `crm_assets` **на запись**, лицензия — только чтение. Запуск: `docker compose … run --rm ctl config apply --layers …
  --yes` (RUNBOOK «Настройки и ассеты»). Через него же идут `seed`, `ingest-key`, `job`, `secrets`.
- `CRM_ASSETS_DIR=/var/lib/crm/assets` задаёт `environment:` у `app` и `ctl` в `compose.yaml`, а не `app.env`: путь
  привязан к точке монтирования, а `app.env` старых установок `crmctl update` не переписывает. В
  `deploy/compose/app.env.example` — пояснение закомментированной строкой.
- Владелец тома: пустой именованный том при первом монтировании получает владельца и права каталога образа.
  `Dockerfile` создаёт `/var/lib/crm/assets` с владельцем `node` до `USER node`, поэтому `ctl` (uid 1000) может писать.
  Кто смонтирует том первым (`app` или `ctl`), неважно.
- Копия: том в резервную копию не входит (только копии файлов пакета и накладки, ПДн нет). После восстановления его
  заново заполняет `ctl config apply` — шаг RUNBOOK «Проверка восстановления».
- `/stand-assets/` закрыт в `.dockerignore`: в контекст сборки образа не попадает. `scripts/check-image.sh` и правило
  «в образе нет `src/`, `*.ts`, `*.map`» не меняются: точка монтирования — пустой каталог.

## 3. Отвергли

- **Хранить логотип в БД** (таблица или base64 в документе настроек). Нужна миграция или раздутый документ ревизий,
  а D-061 уже выбрал том. Стенд это решило бы, но ценой схемы.
- **Брать файл из `presets/*/assets` образа по имени.** Порядок слоёв на запуске неизвестен (два слоя с
  `logo.svg`), а накладка клиента лежит вне образа (D-061).
- **Класть логотип в `public/`.** Имя клиента попало бы в `public/` (стоп-слова), а на установке логотип
  менялся бы только пересборкой.
- **`next/image` с `dangerouslyAllowSVG`** или встраивание SVG в разметку. Активное содержимое SVG попадает в
  документ приложения.
- **Санитайзер SVG.** Новая зависимость. Показ только через `<img>` (в нём SVG не выполняет скрипты и не грузит
  внешнее) и `sandbox` для прямого открытия закрывают тот же риск.
- **Решать «картинка или текст» по наличию `theme.logo`.** У `base` логотип есть, базовая установка потеряла бы
  название. Сравнивать с ключом базового пресета в коде нельзя: это знание пресета в продукте.
- **Кэш по ревизии настроек.** Тот же ключ с новым файлом ревизию не меняет (`config apply` копирует файл, документ
  тот же). Хеш содержимого меняется всегда.

## 4. Задачи

| # | Задача | Уровень | Поток | Зависит от |
|---|---|---|---|---|
| UI-3a | Ядро и пресеты: `theme.brandMark` (необязательный enum) в `v1.ts`, тест схемы (нет ключа — верно; `'logo'`/`'name'` — верно; иное — ошибка); `"brandMark": "name"` в `presets/base`, `"logo"` в `presets/clients/crp` (описание ключа — CONFIG §6.14) | T1 | platform | — |
| UI-3b | Сервер: `readAssetFile` экспортом из `preset-files.ts`, `src/server/platform/brand/{logo.ts,index.ts}` (`readLogo`, `logoResponse`), `reason: 'asset'` в `publicRoute`, маршрут `src/app/api/brand/logo/route.ts`, запись в `tests/isolation/manifest/platform.ts` и `STATIC_POLICY.publicRoutes` (`'GET /api/brand/logo': 'asset'`). Тесты §5 п. 1–3 | T2→T1 (дизайн готов, `reviewer` обязателен: загрузка файла, публичный маршрут) | platform | UI-3a |
| UI-3c | UI: `loadBrand`, `BrandMark`, `AuthBrand`, правка `RoleShell`/`AppShell`, login и invite. Тесты §5 п. 4–5 | T1 | platform | UI-3b |
| UI-3d | Стенд Vercel: `CRM_ASSETS_DIR=stand-assets` в `vercelStandOverlay` (перекрывает явное), `'./stand-assets/*'` в `outputFileTracingIncludes`, `/stand-assets/` в `.gitignore`; `scripts/demo/local.sh` экспортирует `CRM_ASSETS_DIR="$DEMO_DIR/assets"` до сида и `next start`; строка в `docs/ops/VERCEL.md`. Тест §5 п. 6 | T1 | platform (`docs/ops/VERCEL.md`, `.dockerignore` — через ops) | UI-3b |
| UI-3e | **Сделано** (D-334): том `crm_assets` в `compose.yaml` (app — `:ro`, `ctl` — запись), `CRM_ASSETS_DIR` в `environment:` app и `ctl` (в `app.env.example` — пояснение), сервис `ctl` (профиль `tools`), каталог с владельцем `node` в `Dockerfile`, `/stand-assets/` в `.dockerignore`, RUNBOOK «Настройки и ассеты» и шаг «после восстановления — `ctl config apply`», DEPLOY §3.1/§6.1, CONFIG §7. Тест `tests/unit/ops/compose-assets.test.ts` | T2→T1 (поставка) | ops | — |
| UI-3h | `crmctl install` и хостовый `crmctl config …`: делегировать в `docker compose run --rm -T ctl config …` (учётке `crmops` доступен только `sudo crmctl`); `install` после миграций применяет слои пресета (DEPLOY §4 п. 3). Слои и путь накладки — из `state.json`/флага, не из кода | T2→T1 | ops | UI-3e |
| UI-3f | e2e: §5 п. 7 в `tests/e2e/ui-grid.spec.ts` (критерий 10) и отдельный `tests/e2e/brand-logo.spec.ts`; снимки 01, 12 «после» | T1 (`tester`) | platform | UI-3c, UI-3d |
| UI-3g | Ревью каждой ветки | T2 (`reviewer`) | — | каждая |

Миграций БД нет. `package.json` не меняется.

## 5. Тесты

1. **Unit `tests/unit/brand/logo.test.ts`** (временный каталог): `readLogo` отдаёт байты, тип и хеш для `.svg`,
   `.png`, `.webp`. `null` возвращается, если: `CRM_ASSETS_DIR` не задан; файла нет; на месте файла симлинк или
   каталог; файл больше `ASSET_MAX_BYTES`; имя `../x.svg`, `X.svg`, `a/b.svg`; расширение `.woff2`. Повторный
   вызов без изменений файла не читает его заново (счётчик чтений). Подмена файла через rename даёт новый хеш.
2. **Unit `tests/unit/brand/logo-route.test.ts`** (без БД: `logoResponse(req, deps)` принимает
   `deps = { logoKey: () => Promise<string | null>, env }`, по умолчанию — активные настройки и `process.env`): 200 с `Content-Type: image/svg+xml`, `X-Content-Type-Options:
   nosniff`, CSP содержит `default-src 'none'` и `sandbox`, `Cross-Origin-Resource-Policy: same-origin`, `ETag`.
   `?v=<hash>` → `immutable`, без `v` или с чужим `v` → `no-cache`. `If-None-Match` с этим ETag (и с `W/`) → 304
   без тела. Нет файла или нет настроек → 404 `not_found`, `no-store`. Нет `Set-Cookie`. Тело не зависит от
   `?v=../../etc/passwd`.
3. **Статические:** `tests/unit/static-isolation-manifest.test.ts` проходит с новой записью (без неё падает, это
   уже покрыто). Новая проверка в `tests/unit/static-brand.test.ts`: в `next.config.ts` нет `dangerouslyAllowSVG`;
   в `src/ui/shells/BrandMark.tsx` нет `next/image` и `dangerouslySetInnerHTML`; `route.ts` логотипа не читает
   `params`. Стоп-слова клиента (существующий тест) остаются зелёными.
4. **Unit `tests/unit/shells/brand.test.ts`:** `loadBrand` возвращает `logoSrc: null` при отсутствии
   `brandMark`, при `'name'`, при `'logo'` без файла. При `'logo'` с файлом возвращает
   `/api/brand/logo?v=<hash>`. `name` берётся из `productName.ru`, запасной — из локали.
5. **Unit `BrandMark`** (`renderToStaticMarkup`): текстовый режим — `<strong data-testid="shell-brand">`. Режим
   логотипа — `<img alt="<name>">` с `height` 28/40 px, `width:auto`, `object-fit:contain`, без `srcset` и
   `_next/image`.
6. **Unit стенда** (`tests/unit/platform/vercel-stand.test.ts`, дополнен): в режиме стенда `set.CRM_ASSETS_DIR
   === 'stand-assets'`, даже если в окружении задано другое; если уже `stand-assets` — не перезаписывается.
7. **Интеграционный `tests/integration/platform/brand-logo.test.ts`** (Postgres 16): `writeConfig` с пресетом, где
   `brandMark: 'logo'`, и синтетический SVG в `CRM_ASSETS_DIR`. GET обработчика отдаёт те же байты. После замены
   файла меняется ETag. Состояние лицензии `read_only` и `expired` → по-прежнему 200. `loadBrand` выдаёт
   `logoSrc`.
8. **e2e** на сиде (`clients/crp` → `brandMark: 'logo'`), pixel-7 и 1440×900:
   - `expectBrand` (критерий 10 `ui-grid`): если в ревизии `theme.brandMark = 'logo'`, то в `shell-brand` есть
     `img` с `alt` = `productName`, `naturalWidth > 0`, высота 28 ± 1 px, отношение ширины к высоте равно
     `naturalWidth / naturalHeight` ± 1 % (без искажения); иначе текст, как сейчас;
   - `/login`: `img` с тем же `alt`, высота 40 ± 1 px;
   - `request.get(src)` → 200, `image/svg+xml`, `nosniff`, CSP с `sandbox`, `ETag`, `immutable`;
     `request.get('/api/brand/logo')` с `If-None-Match` → 304;
   - отказ загрузки: `page.route('**/api/brand/logo**', r => r.abort())` → в `shell-brand` текст `productName`;
   - вне сида — на стенде Vercel ручная проверка снимком 01 и 12 (логотип виден).
