# Руководство по эксплуатации (RUNBOOK)

Нормативно: `docs/DEPLOY.md` §4–5, `docs/ARCHITECTURE.md` §8.3. Здесь — команды. Разделы про копии и
восстановление добавляет задача O3. Секретов, адресов и паролей в этом файле нет и быть не должно.

## Пакет релиза

Каталог после распаковки `crm-<клиент>-<версия>.tar.zst` (или сам архив: `crmctl` распакует его в
`/var/lib/crm/packages/<имя>`):

| Файл | Что |
|---|---|
| `manifest.json` | `customer`, `version`, `buildId`, `schemaVersion` (имя последней SQL-миграции), `configSchemaVersion`, `minFromVersion`, `images[]` (`ref` вида `crm-app:<версия>` и `digest` = `docker image inspect --format '{{.Id}}'`) |
| `manifest.sig` | подпись манифеста (проверка — O4c, пока заглушка) |
| `images.tar` | `docker save` образа `crm-app:<версия>` |
| `compose/` | `compose.yaml` и `postgres-init/` из `deploy/compose/` |
| `nginx/` | `crm.conf.template`, `maintenance.html` из `deploy/nginx/` |

## Установка с нуля

Порядок и роли — DEPLOY §4. Здесь шаги 2–3.

1. Root ЦРП, один раз (пакет уже распакован в `/root/crm-pkg`):
   ```
   ./install.sh --package /root/crm-pkg --domain crm.<сайт ЦРП> --owner-user crmops
   ```
   Ставит Docker, nginx, certbot, ufw (22, 80, 443), fail2ban, chrony, `crmctl` (node и `crmctl.mjs`
   берутся из образа пакета), cron `crmctl health` раз в 5 минут, logrotate на 14 дней, сеть `crm_ingest`,
   sudo для `crmops` **только** на `/usr/local/bin/crmctl`. БД и приложение не создаёт.
2. Владелец, от `crmops`:
   ```
   sudo crmctl install /root/crm-pkg --domain crm.<сайт ЦРП> --admin-phone <номер> --admin-name "<имя>"
   ```
   Шаги: проверка окружения и подписи, `/etc/crm/{app,db,project}.env` (0600), загрузка образов,
   БД, роли, миграции под `crm_owner`, `deploy/postgres/grants.sql`, `installId`, первый
   администратор, запуск `app` и `worker`, проверка `/api/health`.
3. **Вывод команды показывается один раз.** Сохраните вне сервера: `installId`, ссылку первого входа
   администратора (одноразовая, 72 ч, формат `https://<хост>/invite#<токен>`), три ключа
   (`CRM_SECRETS_KEY_k1`, `CRM_PHONE_HMAC_KEY`, `CRM_IIN_HMAC_KEY`). Копия ключей вне сервера и
   запечатанный конверт директору — обязательны: без ключей зашифрованные поля не восстановить.
4. Сертификат: `certbot certonly --webroot -w /var/www/certbot -d crm.<сайт ЦРП>`, затем
   `./install.sh --nginx-only --domain crm.<сайт ЦРП>` (подставит шаблон и перечитает nginx).
5. Лицензия: `installId` → владельцу → подпись офлайн → `crmctl license install` (команда P10).
   До этого установка в состоянии `missing` («только чтение»).

Если установка оборвалась (например, `app` не ответил), повторный `crmctl install` безопасен: файлы
окружения и `installId` сохраняются, миграции идемпотентны, выдаётся новая ссылка входа.
`state.json` пишется только после успешного `/api/health`; пока его нет, `install` не отказывает.

## Обновление

```
sudo crmctl update /var/lib/crm/packages/crm-crp-1.2.0.tar.zst
```

1. Пакет: версия выше текущей, тот же клиент, `minFromVersion`, схема не ниже накатанной, подпись.
2. `docker load`, сверка образов с манифестом; **лицензия проверяется новым образом**, `invalid` —
   стоп, прежняя версия работает.
3. Если есть ненакатанные миграции — копия БД (`/usr/local/lib/crm/backup.sh`, ставит O3); не вышла —
   стоп. Затем `migrate` под `crm_owner` и `grants.sql` (применяется при каждом обновлении).
4. Новая версия поднимается отдельным контейнером `crm-app-next` в сети `crm_internal` (порты не
   публикуются) и проверяется `/api/health`; нездорова — стоп, прежняя работает.
5. Переключение: `docker compose up -d app worker` с новой версией (app пересоздаётся за секунды,
   nginx показывает страницу обслуживания). Проверка `/api/health` сразу и через 2 минуты
   (`--recheck-seconds`). Сбой любой из них или `compose up` — **автооткат** на прежний тег.
6. Код выхода: 0 — готово; 1 — остановлено или откатилось, прежняя версия работает; 2 — откат не
   удался, нужно вмешательство (`crmctl status`, `docker compose -p crm logs app`).

Окна выкладки в пилот — DEPLOY §5.3.

## Откат

```
sudo crmctl rollback
```

Поднимает прежнюю версию (около минуты), возвращает её `compose.yaml`, меняет местами `current` и
`previous`: повторный `rollback` вернёт новую. БД не откатывается (миграции только добавляющие,
D-060); правки настроек, сделанные новой версией, после отката не видны, команда об этом
предупреждает. Образ прежней версии должен быть на сервере (чистка образов оставляет текущий и
прежний). Выход 2 — прежняя версия не отвечает.

## Состояние и проверка

```
sudo crmctl status   # версии, installId, контейнеры, /api/health
crmctl health        # одна строка и код выхода 0/1 (для cron и мониторинга)
```

Файлы: `/var/lib/crm/state.json` (версии, без секретов), `/etc/crm/project.env` (`CRM_VERSION` для
compose), `/var/lib/crm/compose/` (текущий compose), `compose.prev/` (прежний). Переменные для тестов
и нестандартных путей: `CRM_ETC_DIR`, `CRM_LIB_DIR`, `CRM_CLI_DIR`, `CRM_BACKUP_CMD`.

## Известные ограничения

- Проверка подписи пакета и лицензии — заглушка (реализуют O4c и P10): без `CRM_VERIFY_STUB=allow`
  `install` и `update` останавливаются. Разрешение допустимо только на стенде и в тестах.
- Переключение — пересоздание `app` (секунды простоя, страница обслуживания), не бесшовная замена:
  два `app` с публикацией порта и псевдонимом `crm-app` одновременно не живут. Новая версия до
  этого проверяется отдельным контейнером.
- `worker` не стартует, пока нет `dist/worker.mjs` (задача воркера); `app` от этого не зависит.
