# Образ и compose (задача O1)

Описательная заметка; нормативно — `docs/ARCHITECTURE.md` §8 и `docs/DEPLOY.md` §3–5.

## Файлы

| Файл | Что |
|---|---|
| `Dockerfile` | deps → build (`next build --webpack`, standalone, esbuild для `dist/*.mjs`) → runtime `node:22-slim`, пользователь `node` (uid 1000), корень ФС образа только на чтение |
| `.dockerignore` | в контекст не попадают `.git`, `tests`, `docs`, `*.map`, окружения и ключи |
| `deploy/compose/compose.yaml` | проект `crm`: `app`, `worker`, `db`, `migrate` (профиль `tools`), `nginx` (профиль `edge`) |
| `deploy/compose/*.env.example` | образцы `/etc/crm/app.env`, `/etc/crm/db.env`, переменных подстановки compose |
| `deploy/compose/postgres-init/10-roles.sh` | роль `crm_app` при первом создании тома (`crm_owner` создаёт сам образ) |
| `deploy/nginx/crm.conf.template` | TLS, HSTS, CSP, журнал без query string и Referer, `X-Via-Proxy`, `/api/ingest/` закрыт при `INGEST_PUBLIC=0` |
| `scripts/check-image.sh` | `check-image.sh <образ>` или `--dir <каталог>`: нет `*.map`, `*.ts`, `src/`, `packages/core/src`, `tests/`, `.git`, `.env*`, ключей. Нарушение — выход 1 |

## Сборка и проверка

```
docker build -t crm-app:<версия> --build-arg BUILD_ID=<sha> .
# клиентский образ: + --build-arg CUSTOMER_ID=<клиент> --build-arg BUILT_AT=$(date +%s%3N) --secret id=license_keys,src=<keys.json>
# BUILT_AT — время сборки в водяном знаке: лицензия прежней сборки работает не дольше 7 суток от него (D-290)
scripts/check-image.sh crm-app:<версия>
```

За корпоративным прокси: `--secret id=npmca,src=<ca.pem>` (сертификат только на время `npm ci`).

В образе: `.next/standalone`, `.next/static`, `public`, `dist/{migrate,crmctl,worker}.mjs`
(собираются, если есть `scripts/db-migrate.ts`, `scripts/crmctl/index.ts`, `scripts/worker/index.ts`),
`migrations/*.sql`, `presets/`, `deploy/postgres/grants.sql`. npm/npx/corepack из рантайма удалены.

## Сети

- `crm_internal` (`internal: true`, без маршрута наружу): `db`, `app`, `worker`, `migrate`. БД недоступна из интернета и из `crm_egress`.
- `crm_egress`: исходящие соединения `app` и `worker` (интеграции). БД сюда не подключена.
- `crm_ingest` — внешняя, создаёт `install.sh` (`docker network create crm_ingest`). У `app` в ней псевдоним `crm-app`, порт 3000. Источник лидов описан в отдельном репозитории.
- Наружу публикуется только `127.0.0.1:3100 -> app:3000`. Профиль `edge` добавляет `80/443` (для стенда без nginx на хосте).

## Порядок запуска

```
docker network create crm_ingest            # один раз (install.sh)
docker compose -f deploy/compose/compose.yaml up -d db
docker compose -f deploy/compose/compose.yaml run --rm migrate   # под crm_owner
# затем grants.sql под crm_owner (шаг crmctl), затем:
docker compose -f deploy/compose/compose.yaml up -d app worker
```

## Известные ограничения

- `worker` не стартует, пока нет `dist/worker.mjs` (точка входа `scripts/worker/index.ts` — отдельная задача). Healthcheck воркера — по процессу; heartbeat в БД добавит задача воркера.
- CSP содержит `'unsafe-inline'` для скриптов (Next); переход на nonce — отдельно.
- Ядро (`packages/core`, D-028) собирается в образе `build.mjs` до `next build`; клиентский образ — `--build-arg CUSTOMER_ID/BUILD_ID` и секрет `license_keys` (открытые ключи лицензий). `dist/{migrate,crmctl,worker}.mjs` собирает `scripts/crmctl/build-cli.mjs`: ядро в них внешнее, берётся из образа. Слой клиента поверх готового образа (`FROM crm-app:<версия>`) — задача O1b.
