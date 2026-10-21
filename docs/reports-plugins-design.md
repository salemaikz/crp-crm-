# Отчёты, выгрузки, панель директора, канбан, настройки продаж, плагины интеграций — дизайн R3a · R3b · R4 · B8 · R2b · O6 · O7a

Статус: дизайн architect, 24.10.2026. Нормативно: PROCESS §4.2–4.4, §8.1–8.3, §8.6, §9.1, §10, §11; CONFIG §2, §4–5,
§6.2, §6.7, §6.12, §7–8; INTEGRATIONS §1–4, §7–8; D-016, D-017, D-024…D-026, D-039, D-042, D-047, D-054, D-055,
D-074, D-122, D-153, D-202; решения этого дизайна **D-261…D-271**; правки по ревью линии integrations — **D-297…D-299**
(21.10.2026). Все примеры — синтетика (+7 709 …, «ТОО Пример»).
Next 16: перед маршрутами и страницами прочитай `node_modules/next/dist/docs/` (route handlers, `params` — Promise).
Ядро — только корень `@crm/core`.

Обозначения: `S(entity, perm)` = `${scopeSql(viewer, entity, perm)}` внутри `scoped(sql)`; «тх» — `db.tx` с повтором
при 40P01/40001 до 3 раз (как `calls/tx.ts`); `$tz` — `org.timezone`; `$s` — `viewer.spaceId`.

**Сигнатуры (написаны architect, менять только через architect):**
`src/integrations/contract.ts`, `src/server/domain/reports/reportTypes.ts`, `src/server/platform/secrets/types.ts`.

---

## 0. Что когда (PLAN §4, §6.1–6.2)

В пилот 27.10 (PLAN §6.1) ничего из этого дизайна **не обязательно**: `tel:` и `wa.me` остаются помощниками
`src/shared`, лимит меняется `crmctl config set`. Всё ниже — к релизу 01.11 (§6.2), кроме R2b, который при
успехе входит в `0.9.0`.

| Часть | Поток | Входит | Срок влития |
|---|---|---|---|
| §5 **R2b** настройки продаж (лимит, окно звонков, расписание раздачи, норма, праздники) | manager | `0.9.0`, если влит к **26.10 12:00**; иначе `0.9.1` | 26.10 12:00 |
| §7 **O6** контракт, реестр, `telephony.manual`, `messenger.wa_link`, заготовка Beeline, секреты (покрывает O5), приём вебхуков | ops (+platform) | 01.11 | 27.10 |
| §1 **R3a** отчёты за период | manager | 01.11 | 27.10 |
| §8 **O7a** `messenger.wazzup` за `FEATURE_WAZZUP` на фикстурах | ops (+base, calling) | 01.11, флаг в production выключен | 28.10 |
| §2 **R3b** выгрузки CSV/XLSX, журнал, полная выгрузка | manager | 01.11 (XLSX — `FEATURE_REPORTS_EXPORT`, режется в CSV по списку Б) | 28.10 |
| §4 **B8** канбан сделок и вид «Обзвон» | booking | 01.11 за `FEATURE_KANBAN` (режется только решением владельца, список В) | 29.10 |
| §3 **R4** панель директора | manager | 01.11 (список Б, п. 3) | 29.10 |

---

## 1. R3a: отчёты за период (D-261, D-262)

### 1.1. Файлы (manager)

| Файл | Что |
|---|---|
| `src/server/domain/reports/reportTypes.ts` | **сигнатуры** (готово) |
| `reports/period.ts` | `resolvePeriod` (чистая), `weekOf(today)`, `bucketOf(day, grouping)` |
| `reports/definitions.ts` | чистые: `rate(n, d)` (1 знак, null при 0), `callsPerHour(outcomes, hours)`, `ISSUE_KINDS`, `CLOSING_KINDS` |
| `reports/periodRepo.ts` | весь SQL §1.4 (SQL модуля — только здесь и в `repo.ts`) |
| `reports/operators.ts`, `funnel.ts`, `revenue.ts`, `attendance.ts`, `reasons.ts` | сборка отчётов из строк repo |
| `reports/get.ts` | `getReport: GetReport` — проверка охвата, `resolvePeriod`, диспетчер по `q.key` |
| `reports/index.ts` | + экспорт новых функций и типов |
| `src/app/api/reports/[key]/route.ts` | `GET` отчёт (JSON) |
| `src/app/(mgr)/reports/page.tsx`, `ReportsScreen.tsx`, `PeriodPicker.tsx`, `ReportTable.tsx`, `api.ts`, `types.ts` | экран |
| `messages/ru/reports.json` | + разделы §10 |

### 1.2. Период и фильтры

- Параметры запроса: `from`, `to` (`YYYY-MM-DD`, местные дни, включительно), `users` (id через запятую, ≤ 50),
  `source` (ключ источника), `group` (`total|day|week`, только operators), `by` (funnel: `operator|source`;
  attendance: `event_type|consultant|author`). Разбор — Zod `.strict()` в маршруте.
- `resolvePeriod`: `fromMs = time.fromLocalTime(from,'00:00',tz)`, `toMs = time.fromLocalTime(addLocalDays(to,1),'00:00',tz)`;
  ошибки → `400 period_invalid`: формат, `from > to`, длина > 92 дня, `to` позже завтра.
- По умолчанию — текущая неделя: понедельник (`addLocalDays(today, 1 − isoWeekday(today))`) … сегодня.
  Быстрый выбор в UI: Сегодня, Вчера, Эта неделя, Прошлая неделя, Этот месяц, Прошлый месяц, Свой период.
- Неделя корзины — с понедельника (ISO).

### 1.3. Определения (PROCESS 10.1, D-261, D-262)

| Показатель | Определение | Кому засчитывается | Индекс v1 |
|---|---|---|---|
| Выдано | различные `card_id` в `assign_log` с `kind ∈ ISSUE_KINDS = auto, manual, return, inbound, proposal` (новые для оператора, D-039), `day` в периоде | `to_user_id` | `assign_day_idx` |
| Итог | `calls` с `via <> 'import'` (в том числе `offline`, `manual_entry`) | `calls.user_id` | `calls_stats_idx` |
| Дозвон | итог вида-дозвона (`connectedKinds`, как в сводке R1a) | звонившему | `calls_stats_idx` |
| ЛПР | карточка, у которой **первый** применённый звонок с `lpr='yes'` (за всё время) попал в период | автору этого звонка | `calls_card_idx` |
| Запись | `bookings` — **голова цепочки переноса** (`moved_from_id IS NULL`), `via <> 'import'`, кроме `status='cancelled' AND cancel_reason='operator_error'`; по `created_at` | `booked_by_user_id` | короткий скан `bookings` |
| Явка | `attended / (attended + no_show)` по `booking_date` в периоде, без резерва | автору записи | то же |
| Покупка | `deals.status='won'`, `won_at` в периоде, сумма `amount_kzt` | **автору первой записи сделки** (`bookings.deal_id`, раньше всех по `created_at, id`); записи нет — `deals.owner_user_id` | `deals_board_idx` |
| Повторная покупка | выигранная сделка клиента не первая по `(won_at, id)` в пространстве | — | `deals_client_idx` |
| Пропуски | `skips` по `day` | `user_id` | `skips_day_idx` |
| Часы в работе | по каждому дню — число местных часов с ≥ 1 итогом; за период — сумма по дням | — | `calls_stats_idx` |
| Звонков в час | итоги периода / часы в работе периода, 1 знак; `null` при 0 ч | — | — |
| Ниже нормы | `callsPerHour < reports.callsPerHourTarget` (если норма задана); **только число и отметка**, без цвета и блокировок | — | — |
| Источник | первый `client_sources` клиента по `(first_seen_at, id)`: `source_key`, если не пусто, иначе `source_kind` | — | `client_sources_client_idx` |

Воронка — **воронка периода**: каждый шаг считает свои события в периоде (не когорта). Так и написано в подсказке
экрана (`reports.funnel.hint`).

Сводка дня R1a считает ЛПР и записи упрощённо (различные карточки с `lpr='yes'` за день; записи без
`cancelled`/`moved`). Перевод сводки на эти определения — задача **R3a-5** в `0.9.1` (после пилота, чтобы не
трогать работающую сводку).

### 1.4. SQL (`periodRepo.ts`)

Все функции: первый аргумент `viewer`, второй `sql`; возвращают строки «сотрудник × местный день»
(`day = to_char(to_timestamp(x/1000.0) AT TIME ZONE $tz, 'YYYY-MM-DD')`); корзины `day/week/total` собирает
`operators.ts` в JS (≤ 50 сотрудников × 92 дня). Деньги — `sum(amount_kzt)::text`, в JS `Number()` с проверкой
`Number.isSafeInteger` (postgres.js отдаёт bigint строкой).

```sql
-- callsByUserDay(viewer, sql, {spaceId, fromMs, toMs, tz, connectedKinds, userIds|null})
SELECT ca.user_id, to_char(to_timestamp(ca.occurred_at/1000.0) AT TIME ZONE $tz, 'YYYY-MM-DD') AS day,
       count(*)::int AS outcomes,
       (count(*) FILTER (WHERE ca.outcome_kind = ANY($connected::text[])))::int AS connects,
       (count(DISTINCT extract(hour FROM to_timestamp(ca.occurred_at/1000.0) AT TIME ZONE $tz)))::int AS hours
  FROM calls ca
 WHERE ca.space_id = $s AND ca.user_id IS NOT NULL AND ca.via <> 'import'
   AND ca.occurred_at >= $fromMs AND ca.occurred_at < $toMs
   AND ($users::text[] IS NULL OR ca.user_id = ANY($users::text[]))
   AND S('call','card.read')
 GROUP BY 1, 2;

-- lprFirstByUserDay: первый применённый «ЛПР да» карточки
WITH f AS (SELECT DISTINCT ON (ca.card_id) ca.card_id, ca.user_id, ca.occurred_at
             FROM calls ca
            WHERE ca.space_id = $s AND ca.lpr = 'yes' AND ca.applied = 'applied' AND ca.user_id IS NOT NULL
              AND S('call','card.read')
            ORDER BY ca.card_id, ca.occurred_at, ca.id)
SELECT f.user_id, to_char(to_timestamp(f.occurred_at/1000.0) AT TIME ZONE $tz, 'YYYY-MM-DD') AS day, count(*)::int AS lpr
  FROM f WHERE f.occurred_at >= $fromMs AND f.occurred_at < $toMs GROUP BY 1, 2;

-- issuedByUserDay: служебная таблица без данных клиентов; охват проверен в getReport (report.view ≥ space)
SELECT a.to_user_id AS user_id, a.day, count(DISTINCT a.card_id)::int AS issued
  FROM assign_log a
 WHERE a.space_id = $s AND a.day BETWEEN $from AND $to AND a.to_user_id IS NOT NULL
   AND a.kind = ANY($issueKinds::text[])
 GROUP BY 1, 2;

-- bookedByUserDay: головы цепочек переноса
SELECT b.booked_by_user_id AS user_id, to_char(to_timestamp(b.created_at/1000.0) AT TIME ZONE $tz, 'YYYY-MM-DD') AS day,
       (count(*) FILTER (WHERE b.kind = 'group'))::int AS groups,
       (count(*) FILTER (WHERE b.kind = 'individual'))::int AS consults
  FROM bookings b
 WHERE b.space_id = $s AND b.booked_by_user_id IS NOT NULL AND b.moved_from_id IS NULL AND b.via <> 'import'
   AND NOT (b.status = 'cancelled' AND b.cancel_reason = 'operator_error')
   AND b.created_at >= $fromMs AND b.created_at < $toMs AND S('booking','booking.read')
 GROUP BY 1, 2;

-- attendanceByUserDay: по дате встречи, без резерва
SELECT b.booked_by_user_id AS user_id, b.booking_date AS day,
       (count(*) FILTER (WHERE b.status = 'attended'))::int AS attended,
       (count(*) FILTER (WHERE b.status = 'no_show'))::int AS no_show
  FROM bookings b
 WHERE b.space_id = $s AND b.booking_date BETWEEN $from AND $to AND NOT b.is_reserve
   AND b.status IN ('attended','no_show') AND S('booking','booking.read')
 GROUP BY 1, 2;

-- purchasesByUserDay: автор первой записи сделки, иначе владелец
WITH fb AS (SELECT DISTINCT ON (b.deal_id) b.deal_id, b.booked_by_user_id
              FROM bookings b WHERE b.space_id = $s AND b.deal_id IS NOT NULL
             ORDER BY b.deal_id, b.created_at, b.id)
SELECT COALESCE(fb.booked_by_user_id, d.owner_user_id) AS user_id,
       to_char(to_timestamp(d.won_at/1000.0) AT TIME ZONE $tz, 'YYYY-MM-DD') AS day,
       count(*)::int AS purchases, sum(d.amount_kzt)::text AS sum_kzt
  FROM deals d LEFT JOIN fb ON fb.deal_id = d.id
 WHERE d.space_id = $s AND d.status = 'won' AND d.won_at >= $fromMs AND d.won_at < $toMs
   AND S('deal','deal.read')
 GROUP BY 1, 2;
```

- `skipsByUserDay` — как `selectSkips` сводки, но `day BETWEEN $from AND $to`.
- Фильтр `source`: во всех запросах `AND EXISTS (SELECT 1 FROM first_source fs WHERE fs.client_id = <x>.client_id
  AND fs.key = $source)`, где `first_source` — CTE `SELECT DISTINCT ON (client_id) client_id, CASE WHEN source_key
  <> '' THEN source_key ELSE source_kind END AS key FROM client_sources ORDER BY client_id, first_seen_at, id`.
  Для `assign_log` клиент берётся через `cards`.
- **Воронка by=source** — те же шесть запросов с группировкой по `fs.key` вместо сотрудника.
- **Выручка**:
  ```sql
  WITH w AS (SELECT d.service_type_key, d.amount_kzt, d.won_at,
                    row_number() OVER (PARTITION BY d.client_id ORDER BY d.won_at, d.id) AS n
               FROM deals d WHERE d.space_id = $s AND d.status = 'won' AND S('deal','deal.read'))
  SELECT service_type_key, count(*)::int AS purchases, sum(amount_kzt)::text AS sum_kzt,
         (count(*) FILTER (WHERE n = 1))::int AS first_purchases,
         COALESCE(sum(amount_kzt) FILTER (WHERE n = 1), 0)::text AS first_sum_kzt
    FROM w WHERE won_at >= $fromMs AND won_at < $toMs GROUP BY 1;
  ```
- **Записи и явка**: строки по `booking_date` в периоде, `NOT is_reserve`; ключ группы — `b.event_type_key` |
  `COALESCE(r.user_id,'')` (`LEFT JOIN resources r`; `''` — «серые») | `b.booked_by_user_id`; `booked` = статусы
  `registered, confirmed, attended, no_show`; `unmarked` = `registered|confirmed` с `starts_at < now`;
  `cancelled` = `cancelled`, кроме `operator_error`. `purchases` — различные сделки с `won_at` в периоде, у
  которых есть запись с этим ключом группы (`EXISTS` по `bookings.deal_id`).
- **Причины**:
  ```sql
  SELECT ca.outcome_kind AS grp, ca.reason_code, count(*)::int AS n FROM calls ca
   WHERE ca.space_id = $s AND ca.via <> 'import' AND ca.applied = 'applied'
     AND ca.outcome_kind IN ('not_interested','not_target','do_not_call')
     AND ca.occurred_at >= $fromMs AND ca.occurred_at < $toMs AND S('call','card.read')
   GROUP BY 1, 2
  UNION ALL
  SELECT 'deal_lost', d.lost_reason_code, count(*)::int FROM deals d
   WHERE d.space_id = $s AND d.status = 'lost' AND d.lost_at >= $fromMs AND d.lost_at < $toMs AND S('deal','deal.read')
   GROUP BY 2;
  ```
- Имена сотрудников — один запрос `users` по собранным id (как сводка). Строки операторов: участники раздачи
  (`distribution.participantRoles`) **плюс** любой сотрудник, у которого в периоде есть хоть одно число
  (бывший оператор, РОП с итогами `manual_entry`).

Новых индексов не нужно: при объёмах ЦРП (≈ 30 тыс. звонков в месяц, сотни записей и сделок) запросы идут по
индексам v1 или коротким сканам. Если нагрузочный прогон (Q1c) покажет > 300 мс на отчёт за 92 дня — architect
даёт миграцию `calls (space_id, occurred_at) WHERE via <> 'import'` и `bookings (space_id, booking_date)`.

### 1.5. Доступ, API, экран

- `getReport(viewer, q)`: `scopeOf(viewer,'report.view')` ниже `space` → `ForbiddenError` (раздел: API 403,
  страница 404). «Мой день» оператора и консультанта — другой экран. Директор (только чтение) — да.
- `GET /api/reports/[key]` — `route({perm:'report.view'})`, неизвестный `key` → 404; ответ — `ReportOf<key>`.
- Страница `/reports` — `page({perm:'report.view'})`, параметры `?r=<key>&from&to&…` (ссылкой можно поделиться);
  сервер отдаёт первый отчёт, переключение — через API. Одна таблица, **без графиков** (PROCESS 10.2: не больше
  одного; в 1.0 — ни одного). Шапка: вкладки отчётов, `PeriodPicker`, фильтр сотрудников (мультивыбор), источник,
  группировка; кнопки «CSV», «XLSX» (§2; видны при `report.export`, XLSX — при флаге).
- «Ниже нормы» — серый текст рядом с числом (`text-muted`), без красного (PROCESS 10.2).
- Телефон: таблица прокручивается по горизонтали, первая колонка закреплена (`sticky left-0`).

---

## 2. R3b: выгрузки и журнал (D-263, D-264)

### 2.1. Файлы

| Файл | Поток | Что |
|---|---|---|
| `src/server/platform/files/zipWrite.ts` | platform | потоковый ZIP-писатель (§2.2) |
| `src/server/platform/files/xlsxWrite.ts` | platform | XLSX из `ExportTable` (§2.2) |
| `src/server/platform/files/csvExport.ts` | platform | + `looksLikeFormula(s)` (тот же `FORMULA`), `toExcelCsvLines` (построчный генератор) |
| `src/server/domain/reports/exportTable.ts` | manager | `toExportTable: ToExportTable` — колонки каждого отчёта |
| `reports/exportLog.ts` | manager | `writeExportLog`, `getExportJournal` |
| `reports/tickets.ts` | manager | билеты полной выгрузки в памяти процесса |
| `reports/fullExport.ts`, `reports/fullExportRepo.ts` | manager | полная выгрузка |
| `src/app/api/reports/[key]/export/route.ts` | manager | `GET` выгрузка отчёта |
| `src/app/api/export/journal/route.ts` | manager | `GET` журнал |
| `src/app/api/export/full/ticket/route.ts`, `src/app/api/export/full/route.ts` | manager | полная выгрузка |
| `src/app/(mgr)/reports/exports/page.tsx`, `ExportJournal.tsx`; `src/app/(mgr)/reports/FullExportDialog.tsx` | manager | экраны |
| `src/server/platform/audit.ts` | platform | + сущность `export`, действия `export.report`, `export.full`, `export.guests` |
| `packages/core/src/access/catalog.ts` | platform (дизайн здесь) | + `export.journal` (§2.6) |

### 2.2. Писатели

**CSV** — существующий `toExcelCsv` (BOM, `;`, CRLF, апостроф перед `= + - @`, TAB, CR). Для полной выгрузки —
`toExcelCsvLines(rows: AsyncIterable<CsvCellValue[]>)` с тем же `csvCell`.

**ZIP** (`zipWrite.ts`, Node 22: `zlib.crc32`, `zlib.createDeflateRaw`):
```ts
export function createZipWriter(opts?: { maxTotalBytes?: number }): {
  addFile(name: string, body: Uint8Array | AsyncIterable<Uint8Array>): Promise<void>; // файлы — по очереди
  finish(): Promise<void>;
  abort(code: string): void;
  stream: ReadableStream<Uint8Array>;
};
```
- Локальный заголовок с флагами 3 (data descriptor) и 11 (UTF-8 имя); данные — deflate raw; дескриптор
  `crc32, compressed, uncompressed`; центральный каталог в конце. Без ZIP64: сумма > 3,5 ГБ → `abort('too_large')`.
- Имена — только `[a-z0-9_./-]` (проверка `safeEntryName` из `zip.ts`).
- Противодавление: `ReadableStream` с `pull`; файл целиком в памяти не копится.

**XLSX** (`xlsxWrite.ts`): `writeXlsx(t: {sheetName: string; table: ExportTable}): Promise<Uint8Array>` через тот
же ZIP-писатель (собрать в буфер). Части: `[Content_Types].xml`, `_rels/.rels`, `xl/workbook.xml`,
`xl/_rels/workbook.xml.rels`, `xl/styles.xml`, `xl/worksheets/sheet1.xml`. Строки — **только** `t="inlineStr"`
(элементов `<f>` нет вообще); строка, похожая на формулу (`looksLikeFormula`), получает стиль с `quotePrefix="1"`.
Стили: 0 обычный, 1 заголовок (жирный), 2 текст с `quotePrefix`, 3 деньги `#,##0`, 4 проценты `0.0`. Дни —
текст `YYYY-MM-DD`. XML-экранирование `& < > " '`, вырезать символы, запрещённые в XML 1.0; ячейка ≤ 32 767
символов (обрезка с `…`); строк ≤ 100 000 (больше → `413 too_many_rows`). Закреплённая первая строка
(`<pane ySplit="1" topLeftCell="A2" state="frozen"/>`), ширина колонок по типу.

### 2.3. Выгрузка отчёта

`GET /api/reports/[key]/export?format=csv|xlsx&<параметры отчёта>` — `route({perm:'report.export'})`, по порядку:
1. `Sec-Fetch-Site` ∈ {`same-origin`, `none`} или заголовка нет (тесты) — иначе `403` (D-263: выгрузку не
   запускает чужая страница ссылкой, журнал не засоряется);
2. `format=xlsx` при выключенном `FEATURE_REPORTS_EXPORT` → `404`;
3. `getReport(viewer, q)` (охват §1.5);
4. `toExportTable(key, report, t)` — `t` маршрут берёт из `getTranslations('reports.export')`;
5. `writeExportLog` **до** отдачи тела (журнал пишется, даже если скачивание оборвали);
6. ответ: `text/csv; charset=utf-8` или `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`,
   `Content-Disposition: attachment; filename="crm-<key>-<from>_<to>.<ext>"` (только ASCII), `Cache-Control:
   no-store`, `X-Content-Type-Options: nosniff`.

Право — **только** `report.export` (D-016). `export.allowedRoles` (CONFIG §6.12) код не читает; тест пресета
`tests/unit/config/preset-export-roles.test.ts` сверяет: роли из `export.allowedRoles` = роли с `report.export`.

Кнопки на экране — обычные ссылки `<a href download>` (навигация того же сайта: `Sec-Fetch-Site: same-origin`).

### 2.4. Журнал выгрузок (PROCESS 8.6)

`writeExportLog(viewer, input)` → `writeAudit({action: 'export.report'|'export.full'|'export.guests', entity:
'export', entityId: viewer.userId, spaceId: viewer.spaceId, meta: {kind, reportKey, format, rows, filterKeys,
periodDays}})`. В `meta` — **только** эти ключи; `filterKeys` — имена параметров (`users`, `source`, `group`, `by`),
без значений. Тест проверяет белый список ключей и отсутствие цифровых последовательностей ≥ 5 в `meta`.
Выгрузка списка гостей (B3b/B4) пишет `export.guests` через тот же `writeExportLog` (задача BK-g, §13).

`GET /api/export/journal?before=<at>:<id>` — `route({perm:'authenticated'})`; сервис: `viewer.isAdmin ||
can(viewer,'export.journal')`, иначе `ForbiddenError`. SQL (индекс `audit_log_action_idx`):
```sql
SELECT a.id, a.created_at AS at, a.actor_id, u.name AS actor_name, a.action, a.meta
  FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
 WHERE a.action IN ('export.report','export.full','export.guests')
   AND ($isAdmin OR a.space_id = $s)
   AND ($beforeAt::bigint IS NULL OR (a.created_at, a.id) < ($beforeAt, $beforeId))
 ORDER BY a.created_at DESC, a.id DESC LIMIT 51;
```
Страница `/reports/exports` — `page({perm:'authenticated'})` с той же проверкой (иначе `notFound()`).

### 2.5. Полная выгрузка (D-055, D-264)

**Шаг 1.** `POST /api/export/full/ticket {password}` — `route({perm:'data.export_all'})` (вид `export`: не
блокируется ни «только чтением», ни лицензией, D-054):
1. `rateLimit('fullexport:pw:'+userId, 5, 15 мин)` → `429 rate_limited`;
2. `verifyPassword(password, hash)` (`platform/auth/password.ts`; хэш читает новая `readPasswordHash(sql, userId)`
   в `platform/auth/service.ts`) → неверно: `403 password_invalid`, аудит не пишется;
3. завершённых (`export.full_done`) этого сотрудника за местные сутки ≥ 3 или начатых (`export.full`, с
   оборванными) ≥ 10 → `429 export_limit` (D-294);
3а. идёт выгрузка или есть живой билет другого сотрудника (бронь, D-294) → `429 busy`;
4. билет — 32 байта CSPRNG (base64url); `Map` процесса: `sha256(билет) → {userId, expiresAt = now + 60 с}`;
   не больше 100 записей, просроченные вычищаются при каждой выдаче. Ответ `{ticket, expiresAt}`.

**Шаг 2.** Скрытая форма `<form method="post" action="/api/export/full">` с полем `ticket` (браузер сам скачивает
файл; `Origin` у формы есть — CSRF-проверка обёртки проходит). `route({perm:'data.export_all'})`:
1. нет, просрочен или чужой `userId` → билет гасится, `404`;
2. семафор процесса: одна полная выгрузка одновременно, чужая бронь — тоже занято → `429 busy`, **билет не гасится**
   (D-294); иначе захват и погашение билета — без `await` между проверкой и ними;
3. счётчики строк (`count(*)` с теми же условиями охвата) → `writeExportLog({kind:'full', format:'zip', rows: сумма,
   filterKeys: [], periodDays: null})`;
4. уведомление `export_full_done` (params `{}`, `dedupe_key = export_full:<id записи аудита>`) — активным
   сотрудникам пространства, чья роль даёт `data.export_all`, и всем `users.is_admin` (PROCESS 8.6);
   `insertNotifications` модуля notify в режиме `ignore`;
5. поток ZIP: одна тх `REPEATABLE READ READ ONLY`, `SET LOCAL statement_timeout = '600s'`; каждая таблица —
   курсор по 1000 строк (`sql\`…\`.cursor(1000)`) → `toExcelCsvLines` → `addFile`.
6. после `finish()` — строка `export.full_done` (meta `{rows}`, время начала): только она идёт в лимит
   завершённых (D-294); обрыв и предел 20 минут её не пишут.

Состав архива `crm-full-<YYYYMMDD-HHmm>.zip`:

| Файл | Строки и колонки |
|---|---|
| `manifest.json` | `{format:'crm-full-export', version:1, productVersion, generatedAt, timeZone, space, tables:{имя: строк}}` |
| `config/global.json`, `config/space-<key>.json` | текущие ревизии настроек (CONFIG §4 «Экспорт») |
| `users.csv` | сотрудники пространства: id, имя, роль, статус, админ (без телефона, пароля, сессий) |
| `clients.csv` | клиенты, видимые через карточки пространства (`S('client','client.read')`): id, название, вид, форма, БИН (скрытый `hidden:` — пусто), регион, адрес, почта, сайт, видимые поля `custom` (JSON), `merged_into_id`, создан |
| `contacts.csv`, `client_phones.csv`, `client_sources.csv` (без `external_id`), `consents.csv` | по охвату клиента |
| `cards.csv`, `calls.csv`, `bookings.csv`, `events.csv`, `deals.csv`, `handoffs.csv`, `tasks.csv`, `task_comments.csv`, `notes.csv` | по охвату своей сущности |
| `timeline.csv` | `client_events`: id, клиент, вид, автор, время, сделка, `data` через `pickData` реестра видов |
| `messages.csv` | `messenger_messages` по охвату `messenger_chat` (если строки есть) |

Не выгружаются никогда: хэши паролей, сессии, приглашения, push, `integration_secrets`, `ingest_keys`, `stop_list`,
`iin_hmac`, `webhook_inbox`, `import_rows`, `change_snapshots`, `audit_log`, уведомления. Поля, скрытые для роли
(`fields[].access`), не попадают ни в колонки, ни в `custom` — та же проекция, что `clients/dto.ts` (D-122).
Время — местное `YYYY-MM-DD HH:MM` (`to_char … AT TIME ZONE $tz`), деньги — целые тенге.

Экран: на `/reports` кнопка «Выгрузить все данные» (видна при `data.export_all`) → `FullExportDialog`: текст о
журнале и уведомлении, поле пароля → шаг 1 → скрытая форма шага 2 отправляется сама.

### 2.6. Новое разрешение `export.journal`

- `packages/core/src/access/catalog.ts`: `'export.journal'` в `PERMISSIONS`, `PERMISSION_INFO: {kind: 'read',
  minScope: 'space'}` — разрешено ролям `readOnly`.
- Пресет ЦРП (`presets/clients/crp/preset.json`): директору `{perm:'export.journal', scope:'space'}`. `base`:
  роль «Наблюдатель» (`readOnly`, `space`) — тоже.
- РОП журнал не видит (PROCESS 8.6: администратор и директор).

---

## 3. R4: панель директора (D-265)

- Файлы (manager): `src/server/domain/reports/director.ts` (`getDirectorDashboard`), `src/app/api/reports/director/route.ts`
  (`GET`, `report.view`), `src/app/(mgr)/director/page.tsx`, `DirectorScreen.tsx`; тексты — `reports.json` → `director`.
- Сборка: `week = weekOf(viewer.today)`, `prevWeek` = 7 дней до понедельника. Числа — функции §1.4
  (`callsByUserDay`, `bookedByUserDay`, `attendanceByUserDay`, `purchasesByUserDay`, выручка, воронка `total`) без
  фильтров. Запас: `selectPoolCounts().ready` / (участники раздачи сегодня × `distribution.dailyCap`) — функции
  сводки R1a; `days` до 0,1.
- Экран (телефон и ноутбук): 6 плиток (итоги и дозвоны; БР/БК; явка; покупки и сумма — мелко значение прошлой
  недели; запас в днях), строка воронки с конверсиями, таблица выручки по типам. «Подробнее» → `/reports?r=…` с той
  же неделей; кнопки выгрузки — при `report.export`. Кнопок изменения нет.
- Доступ: `page({perm:'report.view'})` + охват `space`. Директор — роль `readOnly`: любая мутация → `423`
  (обёртка). Тест R4 проходит по манифесту изоляции и вызывает каждый мутирующий маршрут от директора: `423`,
  кроме выгрузок (`export`) и мутаций безопасности D-054.
- Меню: пункт `director` (`/director`, ключ меню роли `dashboard`, `report.view`); у `summary` остаётся только
  ключ `summary` (§6).

---

## 4. B8: канбан сделок и вид «Обзвон» (D-266)

### 4.1. Файлы (booking)

| Файл | Что |
|---|---|
| `src/server/domain/deals/board.ts`, `boardRepo.ts`, `boardTypes.ts` | чтение досок (сделки и обзвон) |
| `src/server/domain/deals/rules.ts` (B6) | `stageRequirements` (B6, docs/deals-handoffs-design.md §5) — **один источник** для доски и `moveDealStage`; B8 добавляет обёртку `missingFor(stage, facts): MissingCode[]` рядом с ней |
| `src/server/domain/deals/types.ts` (B6) | `MoveStageInput.fieldsPatch?: Record<string, unknown>` |
| `src/app/api/kanban/deals/route.ts`, `…/deals/closed/route.ts`, `…/deals/column/route.ts` | `GET` доска, закрытые, «ещё» в колонке |
| `src/app/api/kanban/calling/route.ts`, `…/calling/column/route.ts` | `GET` вид «Обзвон» |
| `src/app/(mgr)/deals/page.tsx`, `DealsBoard.tsx`, `DealTile.tsx`, `MovePanel.tsx`, `useDeferredMove.ts` | доска продаж |
| `src/app/(mgr)/deals/calling/page.tsx`, `CallingBoard.tsx`, `dropRules.ts` | вид «Обзвон» |
| `src/server/domain/calls/types.ts` (calling) | `OUTCOME_VIAS` + `'manual_entry'` (§4.4) |
| `messages/ru/deals.json` | раздел `board` |

Новые пути `src/app/api/kanban/**` координатор добавляет в зону booking (WORKSTREAMS).

### 4.2. Доска продаж

`GET /api/kanban/deals?pipeline=<key>&owner=<userId|all>` — `route({perm:'deal.read'})`; охват `deal.read` ниже
`space` → 403 (оператору ЦРП доска скрыта меню; если другая установка даст `own` — сервис пустит, SQL уже с `S`).
`FEATURE_KANBAN` выключен → 404 (страница — `notFound()`).

```ts
interface DealsBoard {
  pipeline: { key: string; stages: { key: string; kind: 'open'|'won'|'lost'; order: number; staleDays: number|null }[] };
  columns: { stageKey: string; total: number; deals: DealTile[]; nextCursor: string|null }[]; // только open
  closed: { won30d: number; lost30d: number };
  owners: { userId: string; name: string }[];
  can: { edit: boolean; moveBack: boolean; purchase: boolean; lose: boolean };
}
interface DealTile {
  id: string; version: number; stageKey: string; stageChangedAt: number;
  clientId: string; clientName: string; contactName: string|null; phone: string|null; // по проекции полей роли
  fields: { key: string; value: unknown }[];     // ≤ 2 поля с showOn.kanban (сначала deal, затем client)
  nextTask: { id: string; dueAt: number|null; title: string } | null;
  ownerName: string|null;
  badges: { needsRebook: boolean; staleDays: number|null };
  missing: Record<string, MissingCode[]>;       // по каждому открытому этапу воронки
}
type MissingCode = 'booking' | 'attendance' | 'next_step' | `field:${string}`;
```
SQL одной выборкой (индекс `deals_board_idx`):
```sql
WITH d AS (
  SELECT d.*, row_number() OVER (PARTITION BY d.stage_key ORDER BY d.stage_changed_at, d.id) AS rn
    FROM deals d
   WHERE d.space_id = $s AND d.pipeline_key = $p AND d.status = 'open'
     AND ($owner::text IS NULL OR d.owner_user_id = $owner) AND S('deal','deal.read'))
SELECT d.id, d.version, d.stage_key, d.stage_changed_at, d.client_id, d.needs_rebook, d.custom,
       cl.name AS client_name, cl.custom AS client_custom, u.name AS owner_name,
       (SELECT p.digits FROM client_phones p WHERE p.client_id = d.client_id AND p.is_primary) AS phone,
       (SELECT ct.name FROM contacts ct WHERE ct.client_id = d.client_id AND ct.is_decision_maker
         ORDER BY ct.created_at, ct.id LIMIT 1) AS contact_name,
       EXISTS (SELECT 1 FROM bookings b WHERE b.deal_id = d.id
                AND b.status IN ('registered','confirmed','attended','no_show')) AS has_booking,
       EXISTS (SELECT 1 FROM bookings b WHERE b.deal_id = d.id AND b.status = 'attended') AS has_attendance,
       t.id AS task_id, t.due_at AS task_due_at, t.title AS task_title
  FROM d JOIN clients cl ON cl.id = d.client_id LEFT JOIN users u ON u.id = d.owner_user_id
  LEFT JOIN LATERAL (SELECT t.id, t.due_at, t.title FROM tasks t
                      WHERE t.deal_id = d.id AND t.status = 'open' AND S('task','task.read')
                      ORDER BY t.due_at NULLS LAST, t.id LIMIT 1) t ON TRUE
 WHERE d.rn <= 50
 ORDER BY d.stage_key, d.rn;
-- счётчики колонок: SELECT stage_key, count(*)::int … GROUP BY 1 (те же условия)
-- закрытые: count(*) FILTER (WHERE status = 'won' AND won_at >= now − 30 дн), то же для lost_at
```
- Номер, имя контакта, поля — через проекцию полей роли (скрытое → `null` / нет в `fields`).
- `missing[stage] = missingFor(stage, {hasBooking, hasAttendance, hasNextTask: task_due_at IS NOT NULL, filled:
  ключи непустых полей})` на основе `stageRequirements` B6; для `won` и `lost` не считается (у них свои формы).
- «Ещё» в колонке: `GET /api/kanban/deals/column?pipeline&stage&owner&after=<stageChangedAt>:<id>` — следующие 50.
- «Показать закрытые»: `GET /api/kanban/deals/closed?pipeline&before=…` — 50 последних выигранных и проигранных
  (только чтение, тот же `DealTile` без `missing`).

### 4.3. Перенос и «Отменить» (D-266)

Сервер — только маршрут B6 `POST /api/deals/[id]/stage` (`MoveDealStage`: `{opId, version, stageKey, nextStep,
fieldsPatch?}`; вперёд — `deal.edit`, назад — ещё `deal.move_back`; обязательное проверяет сервер на любом пути;
`fieldsPatch` проверяет `buildFieldValidator` D-122 в той же тх; маршрут и ошибки — docs/deals-handoffs-design.md
§5, §6).

Клиент (`useDeferredMove.ts`), по цели:
1. этап `won` → форма покупки B6 (`PurchaseForm`) с этой сделкой; `lost` → диалог причины (`LoseDealInput`);
2. открытый этап ниже текущего и `!can.moveBack` → колонка не принимает (подсветка «нельзя»);
3. `missing[target]` содержит `booking` или `attendance` → не переносим, тост «Нужна запись» / «Нужна отметка явки»;
4. `missing[target]` содержит `next_step` или `field:*` → `MovePanel` **только с недостающими** полями;
   «Перенести» отправляет сразу (явное подтверждение, без «Отменить»);
5. иначе — мгновенно: плитка переезжает, тост «Перенесено в «X» · Отменить» на **5 с**; `POST` уходит по истечении
   5 с (opId создаётся при переносе); «Отменить» снимает таймер, на сервер ничего не уходит. Уход со страницы в
   окне (`pagehide`) — немедленная отправка `fetch(…, {keepalive: true})`;
6. ответы (B6 §6): `409` без `detail` (устаревшая `version`) → перечитать колонку, тост «Сделку изменили, доска
   обновлена»; `409 {detail}` и `400 <код>` → вернуть плитку, тост по коду (`deals.errors.*`); `403` (назад без
   `deal.move_back`) → вернуть плитку; сеть — вернуть плитку, «Нет связи».

Перетаскивание — HTML5 Drag and Drop; у плитки всегда есть меню «Переместить в…» (клавиатура и телефон). На
телефоне (`< md`) перетаскивания нет: колонки — горизонтальная прокрутка со `scroll-snap`, «Переместить в…» →
`BottomSheet` со списком этапов (недоступные — неактивны с причиной).

### 4.4. Вид «Обзвон» (PROCESS 4.4)

`GET /api/kanban/calling?owner=<userId|all>` — `route({perm:'card.read'})`, охват `card.read` ≥ `space` (РОП,
директор), флаг `FEATURE_KANBAN`. Колонки `new`, `retry`, `callback`, `agreed` — карточки **с владельцем** (пул —
экран раздачи), `hold_reason = ''`; плитка «Закрыто» — счётчик `not_interested, not_target, do_not_call,
written_off, client` с `closed_at` за 30 дней.
```sql
SELECT c.id, c.version, c.state, c.client_id, cl.name, COALESCE(c.acting_user_id, c.owner_user_id) AS worker_id,
       u.name AS worker_name, c.attempts, c.next_call_at, c.assigned_at, c.last_outcome_code, c.last_outcome_at,
       row_number() OVER (PARTITION BY c.state ORDER BY
         CASE WHEN c.state = 'new' THEN c.assigned_at WHEN c.state = 'agreed' THEN -c.last_outcome_at ELSE c.next_call_at END
         NULLS LAST, c.id) AS rn
  FROM cards c JOIN clients cl ON cl.id = c.client_id
  LEFT JOIN users u ON u.id = COALESCE(c.acting_user_id, c.owner_user_id)
 WHERE c.space_id = $s AND c.owner_user_id IS NOT NULL AND c.hold_reason = ''
   AND c.state IN ('new','retry','callback','agreed')
   AND ($owner::text IS NULL OR COALESCE(c.acting_user_id, c.owner_user_id) = $owner)
   AND S('card','card.read')
-- внешний SELECT … WHERE rn <= 50; счётчики — GROUP BY state; при фильтре по сотруднику — cards_queue_idx
```
Плитка: название, сотрудник, попытка, срок перезвона, последний итог. Номера для шторки — тем же запросом, что
номера карточки клиента C8.

Перенос = **итог** по тем же правилам (не отдельная механика): `dropRules.ts` (чистая) даёт виды итогов цели:
`retry → no_answer`, `callback → callback`, `agreed → agreed`, «Закрыто» → `not_interested | not_target |
do_not_call`; в `new` и в ту же колонку — нельзя. Открывается та же `OutcomeSheet` (`src/ui/call`) с кнопками
только этих видов и конфигом, который страница грузит так же, как `src/app/(op)/call/page.tsx`; «Договорились» —
тем же путём `onBook`, что `CallScreen` (запись атомарно с итогом, D-202). Отправка — `POST /api/calls/outcomes` с
`via: 'manual_entry'` (D-266): в ленте «внесено вручную», в отчётах — итог РОП. `OUTCOME_VIAS` расширяется
`'manual_entry'` (схема v1 его уже допускает, `calls_via_check`); сервер принимает его от любого с `card.outcome`
на эту карточку. Ядро отклонило переход → плитка возвращается, тост по коду. «Отменить» здесь нет: итог
подтверждается в шторке.

Директор видит обе доски без переноса (`can.*=false`, колонки не принимают).

---

## 5. R2b: настройки продаж в интерфейсе (D-267)

### 5.1. Что правится и кем

| Путь | Область | Кто | Проверка |
|---|---|---|---|
| `distribution.dailyCap` | пространство | `settings.sales` | целое 0–500 |
| `distribution.schedule.{from,to,everyMin}` | пространство | `settings.sales` | `HH:MM`, `from < to`, `everyMin ∈ {15,30,60,120}` |
| `calendar.callWindow.{start,end}` | global | `settings.sales` | `HH:MM`, `start < end` |
| `reports.callsPerHourTarget` | пространство | `settings.sales` | целое 1–100 или `null` («не задана») |
| `calendar.holidays[]` | global | администратор | `{date, kind: holiday|workday, note ≤ 100}`, дата уникальна, ≤ 300 строк |

Остальное (итоги, воронки, роли, поля, повторы) — пресет и CLI до 01.11 (CONFIG §5). **Назначение ролей — только
экран «Сотрудники» (R2a)**; на этом экране ролей нет.

### 5.2. Файлы (manager)

`src/server/domain/admin/salesSettings.ts` (сервис), `admin/salesSettingsPaths.ts` (белый список и Zod-схемы
патча), `src/app/api/admin/settings/sales/route.ts` (`GET`, `PATCH`), `src/app/api/admin/settings/holidays/route.ts`
(`GET`, `PUT`), `src/app/(mgr)/settings/page.tsx`, `SalesSettingsForm.tsx`, `HolidaysEditor.tsx`,
`messages/ru/settings.json`.

### 5.3. Алгоритм

- `GET /api/admin/settings/sales` — `route({perm:'authenticated'})`; сервис: `can(settings.sales) || isAdmin`, иначе
  403. Ответ: `{revs: {global, space}, values: {dailyCap, schedule, callWindow, callsPerHourTarget}, holidays,
  can: {sales, holidays}}` из `getActiveConfig()` (поле `rev` областей).
- `PATCH` — `route({perm:'settings.sales'})`, тело `{expectedRev: {global, space}, patch: {…}}` (Zod `.strict()`,
  только пути §5.1): глубокая копия текущих документов → наложить патч → `writeConfig({docs, source:'ui',
  expectedRev: {global: n, <ключ пространства>: m}, authorId, note: 'ui: <пути через запятую>'})` (аудит
  `config.write` пишет сама запись). Пишутся только изменившиеся области. `ConfigConflictError` → `409
  config_conflict`; `ConfigInvalidError` → `400 invalid` с `issues[].path` (без значений).
- `PUT /api/admin/settings/holidays` — `route({perm:'admin'})`, тело `{expectedRev: {global}, holidays}` → тот же путь
  только для `global`.
- `writeConfig` сбрасывает кэш; действие — по CONFIG §4 (раздача и лимит — со следующего тика, праздник — для
  новых расчётов). Экран пишет это подсказкой под полем.
- Страница `/settings` — `page({perm:'authenticated'})`; без права и не админ → `notFound()`. Разделы видны по
  `can`. Сохранение по разделу; 409 → «Настройки изменил другой сотрудник. Обновите страницу» с кнопкой.
  Праздники: таблица на текущий и следующий год, «Добавить день», «Рабочий день (перенос)», удаление строки.

---

## 6. Меню (общий файл `src/ui/shells/menu.ts`, manager)

- `MenuId` + `'director' | 'integrations' | 'exports'`; подписи `shell.nav.*`, иконки в `ShellNav.tsx`.
- `summary`: ключи только `['summary']`; новый `director`: `/director`, ключ `dashboard`, `report.view`.
- `settings`: `perm: 'settings.sales'` **или** администратор — новое поле `CatalogItem.orAdmin: true`.
- `exports`: `/reports/exports`, `perm: 'export.journal'`, `orAdmin: true`.
- `integrations`: `/integrations`, `adminOnly: true`.
- `kanban` (`/deals`, ключ `deals`, `FEATURE_KANBAN`) — без изменений; «Обзвон» — вкладка страницы `/deals`.

---

## 7. O6: контракт плагинов, реестр, секреты, приём вебхуков (D-268, D-269)

### 7.1. Файлы

| Файл | Поток | Что |
|---|---|---|
| `src/integrations/contract.ts` | ops | **сигнатуры** (готово) |
| `src/integrations/registry.ts` | ops | `registry: PluginRegistry` — статический список |
| `src/integrations/enablement.ts` | ops | `pluginUsability: PluginUsabilityOf` |
| `src/integrations/http.ts` | ops | `createHttp(allowedHosts: string[]): PluginHttp` — fetch с таймаутом; хост вне списка → ошибка `host_not_allowed`; ничего не логирует |
| `src/integrations/telephony/manual/index.ts` | ops | `telephony.manual` |
| `src/integrations/telephony/beeline/index.ts` | ops | заготовка Beeline |
| `src/integrations/messenger/wa-link/index.ts` | ops | `messenger.wa_link` |
| `src/server/platform/secrets/{types,keys,aesgcm,repo,index}.ts` | platform | секреты (§7.4); `types.ts` — **сигнатуры** (готово) |
| `scripts/crmctl/secretsRotate.ts`, `scripts/crmctl/index.ts` | ops | + команда `secrets rotate [--check]` |
| `src/server/domain/integrations/{types,repo,ctx,service,modes,webhook,index}.ts` | ops | подключения, контекст, режимы каналов, приём вебхука |
| `src/server/jobs/integrations.ts`, `src/server/jobs/registry.ts` | ops | обработчики `webhook_inbox`, часть чистки `payload` |
| `src/app/api/hooks/[pluginId]/[token]/route.ts` | ops | общий приём вебхуков |
| `src/app/api/integrations/**` | ops | админ-API (§7.5) |
| `src/app/(mgr)/integrations/page.tsx`, `IntegrationsScreen.tsx`, `WazzupCard.tsx` | ops | экран администратора |
| `src/ui/channels/ChannelModesContext.tsx`, `src/ui/call/dial.ts`, `src/ui/messenger/openChat.ts` | calling | режимы каналов на клиенте (§7.3) |
| `eslint.config.mjs`, `tests/unit/layers.test.ts` | ops | запрет `telHref`/`waHref` в UI вне `dial.ts`/`openChat.ts` |

Новые пути `src/server/domain/{integrations,messenger}/**`, `src/app/api/{integrations,messenger}/**`,
`src/app/(mgr)/integrations/**` координатор добавляет в зону ops (WORKSTREAMS). Домен видит плагины только через
`PluginRegistry` в deps (слои: домен импортирует лишь `@/integrations/contract`); deps собирают маршрут
(`src/app/api/integrations/_lib.ts`) и воркер (`src/server/jobs/integrations.ts`).

### 7.2. Реестр и «можно использовать» (D-268)

- `registry.ts`: `[manualTelephony, beelineTelephony, waLinkMessenger, wazzupMessenger]` (+ `zadarma` в O7b).
  Тест: каждый реализованный плагин в реестре ровно один раз; `flag` — член `FEATURES`.
- `pluginUsability(plugin, gate)` по порядку: `flag && !flagOn` → `flag_off`; `licenseFeature && !licensed` →
  `not_licensed`; `needsConnection && !enabled` → `disabled`; `crossBorder && !crossBorderApproved` →
  `crossborder_not_approved`; иначе `usable`. `licensed` = `license.hasFeature(evaluation, feature)` (ядро).
- Признаки лицензии: `telephony.beeline`, `telephony.zadarma`, `messenger.wazzup`. `manual` и `wa_link` лицензии не
  требуют.

### 7.3. Режимы каналов и замена помощников C7a

`src/shared/tel.ts` и `whatsapp.ts` **остаются** чистыми форматтерами ссылок (они нужны устройству офлайн).
Решение «как звонить и писать» принимает сервер:
- `getChannelModes(viewer, deps): ChannelModes` (`domain/integrations/modes.ts`): телефония — первая пригодная
  (`usable`) интеграция `telephony.*` пространства, иначе `telephony.manual` (`clickToCall:'tel'`); мессенджер —
  `messenger.wazzup`, если пригоден и у пространства есть включённый канал, иначе `messenger.wa_link` (`chat:'link'`).
- `RoleShell` (сервер) кладёт режимы в `ChannelModesProvider`; на офлайн-странице «Звонить» режим берётся из
  последнего ответа.
- `src/ui/call/dial.ts`: `dialAction(phone, modes) → {kind:'tel', href} | {kind:'post'}` (`post` — провайдер с
  `callback`/`originate`, O7b; к 01.11 всегда `tel`). `src/ui/messenger/openChat.ts`: `chatAction(phone, text,
  modes) → {kind:'link', href} | {kind:'panel'}`.
- Перевести на них `src/ui/call/CallCard.tsx`, `src/app/(op)/clients/_ui/CallButton.tsx` (локальный `telHref` в
  `format.ts` удалить), напоминания B3b (`wa.me`). ESLint `importNames: ['telHref','waHref']` для `src/app/**` и
  `src/ui/**`, кроме `src/ui/call/dial.ts` и `src/ui/messenger/openChat.ts`; то же в `layers.test.ts`.
- `telephony.manual.initiateCall` → `{kind:'tel', href: telHref(digits, ext)}` (для будущего `POST
  /api/telephony/initiate` и тестов); `messenger.wa_link.openChat` → `{kind:'link', href: waHref(digits, text)}`.
- Лента «открыт WhatsApp, шаблон X» (INTEGRATIONS §3.1): `POST /api/messenger/opened {cardId, templateKey|null}`
  (`note.write`, section — id в теле; запись: «только чтение» и запирающая лицензия — 423, не больше 20 в минуту на
  сотрудника — 429, D-297) → `client_events` вида `messenger.link_opened {templateKey}`; клиент шлёт без ожидания,
  ошибка не мешает открыть ссылку; офлайн — не шлёт.

### 7.4. Секреты (D-269; покрывает O5)

- Ключи: `CRM_SECRETS_KID` (текущий) и `CRM_SECRETS_KEY_<kid>` (base64, ровно 32 байта; во время ротации их
  несколько). Production без текущего ключа → `SecretError('no_key')` при первом использовании (экран интеграций:
  «Нет ключа шифрования: обратитесь к сопровождению»); dev/test — постоянный тестовый ключ, как `hmac.ts`.
- `sealSecret`: IV 12 байт CSPRNG, `aes-256-gcm`, AAD = `${integrationId}|${name}|${kid}`, тег 16 байт.
  `openSecret`: ключ по `kid` строки; ошибка тега → `auth_failed` (подмена строки или перенос в чужую интеграцию).
- `repo.ts`: `putIntegrationSecret` (upsert по PK; `last4` — последние 4 символа, если длина ≥ 12, иначе пусто),
  `getIntegrationSecret`, `deleteIntegrationSecrets`, `describeIntegrationSecrets`. Это платформа, SQL здесь
  допустим (как `config/repo.ts`).
- `crmctl secrets rotate`: строки с `kid <> current` по 100 в тх: open старым → seal текущим; итог — числа;
  `--check` — все строки открываются текущим набором ключей. Старый ключ удаляет владелец после проверки.
- Контекст плагина (`domain/integrations/ctx.ts`): `buildCtx(row, plugin)` даёт `secrets: async () =>
  plugin.secretsSchema.parse({apiKey: await getIntegrationSecret(sql, {integrationId, name:'apiKey'})})`. Открытый
  секрет живёт только внутри вызова плагина.

### 7.5. Подключения: админ-API (`'admin'`, страница `/integrations`)

| Маршрут | Что | Аудит |
|---|---|---|
| `GET /api/integrations` | по каждому плагину реестра: `flagOn, licensed, crossBorder, needsConnection, usability`; подключение `{id, enabled, status, lastEventAt, crossborderApprovedAt, secrets:[{name,last4}], channels}` | — |
| `POST /api/integrations/connect {pluginId, apiKey}` | флаг и лицензия → иначе 404 / `403 not_licensed`; тх под `pg_advisory_xact_lock` плагина (одно подключение на плагин, D-298): строка `integrations` (пространство по умолчанию, `enabled=false`) + секрет `apiKey`; существующая строка — новый ключ: выключить, сбросить токен, выключить все каналы; вне тх `healthCheck` и `listChannels` → upsert `messenger_channels` (только каналы компании; новые — `is_enabled=false`), `status` | `integration.connect {pluginId, channels}` |
| `POST /api/integrations/[id]/crossborder {approved, decisionDate}` | `true` → `crossborder_approved_at/by`; `false` → `NULL`, `enabled=false` и `webhook_token_hash=NULL` | `integration.crossborder {approved, decisionDate}` |
| `POST /api/integrations/[id]/enable` | уже включено → `409 already_enabled` → пригодность без учёта `disabled` должна быть `usable` (иначе `409 <reason>`) → новый токен (32 байта, хранится `sha256`) условным захватом `UPDATE … WHERE NOT enabled AND (webhook_token_hash IS NULL OR updated_at < now − 5 мин)` (D-322: иначе `409 enable_in_progress` до провайдера) → `subscribe(webhookUrl)` → `syncUsers(активные сотрудники пространства)` → `UPDATE … SET enabled=true WHERE NOT enabled AND webhook_token_hash = <свой>` (D-298: «Выключить» или снятие отметки во время подписки сбросили токен → `409 state_changed`); ошибка провайдера → `502 provider_error`, остаётся выключенной, свой токен сбрасывается | `integration.enable` |
| `POST /api/integrations/[id]/disable` | `securityMutation: 'integration.disable'`; `enabled=false`, `webhook_token_hash=NULL` | `integration.disable` |
| `POST /api/integrations/[id]/rotate-webhook` | `securityMutation: 'integration.revoke_webhook'` (D-054, D-298): старый токен умирает всегда; включена, флаг и лицензия → новый токен и `subscribe`; иначе (выключена, флаг, лицензия «только чтение») и при любой ошибке переподписки → `enabled=false`, `webhook_token_hash=NULL`, ошибка переподписки — `502` | `integration.revoke_webhook {resubscribed, reason?}` |
| `POST /api/integrations/[id]/health` | `healthCheck` + `listChannels` | — |
| `PATCH /api/integrations/[id]/channels/[channelId] {ownerUserId|null, isEnabled}` | владелец — активный сотрудник пространства канала | `integration.channel` |

Ответы и аудит — без ключа, токена и адреса вебхука. Токен не показывается никогда: подписку делает сервер.
`last_event_at` и `status` видны на экране («события идут»).

### 7.6. Общий приём вебхуков (INTEGRATIONS §4)

`POST /api/hooks/[pluginId]/[token]` — `publicRoute({reason:'webhook', origin:'skip'})`:
1. `pluginId ∉ PLUGIN_IDS`, у плагина нет `webhook` или его флаг выключен → `404`;
2. `rateLimit('hook:'+sha256(token).slice(0,16), 600, 60 с)` → `429`;
3. тело `readBodyLimited(req, 256 КБ)` → больше — `413`;
4. `SELECT … FROM integrations WHERE webhook_token_hash = sha256(token) AND plugin_id = $pluginId` → нет → `404`;
5. `verify(ctx, raw)`: `!ok` → `401` (в лог только `pluginId` и код); `test` → `200 {ok:true}` **без записи, даже
   если подключение выключено** (Wazzup шлёт тест при `subscribe`, D-270);
6. `enabled=false` или пригодность ≠ `usable` → `404`;
7. `items = split(ctx, raw)`; > 500 строк → `413`; вставка одним `INSERT … SELECT … FROM unnest(…) ON CONFLICT
   (integration_id, dedupe_key) DO NOTHING`, `state='pending'`, `next_at=now`; `UPDATE integrations SET
   last_event_at = now WHERE id = $id AND (last_event_at IS NULL OR last_event_at < now − 60 000)`;
8. `200 {ok:true}` (и на повтор, и на пустой `split`).

Логи — без тела и токена; nginx маскирует путь (INTEGRATIONS §4 п. 8).

### 7.7. Обработка в воркере

`src/server/jobs/integrations.ts`: `webhookHandlers(): Map<string, QueueHandler>` — ключ `pluginId`
(`QueueItem.handlerKey`). Обработчик: `loadInboxItem(actor, id)` (домен integrations: `payload`, `kind`,
`integration_id`) → `plugin.webhook.parse(kind, payload)` → для `messenger.*` — `applyMessengerEvents(actor, deps,
…)` (§8.5) → `{status:'done'}` | `{status:'retry', error}` | `{status:'failed', error}`. `queueSpecs()` берёт эту
карту; строки без обработчика по-прежнему уходят в `retry no_handler`. Строка уходит в `failed` сразу (исход
`failed`: `invalid_settings`, разбор) или после 8 попыток (`WEBHOOK_MAX_ATTEMPTS`; исключение обработчика — тоже) →
уведомление активным администраторам `integration_inbox_failed {count}` (`count` — failed за сутки, dedupe
`inbox_failed:<integrationId>:<местный день>:<userId>`; `domain/integrations/inboxFailed.ts`, D-298).
Чистка — часть `purgeParts` `webhook_payload`: `UPDATE webhook_inbox SET payload = NULL WHERE payload IS NOT NULL
AND received_at < now − 14 дн` (индекс `webhook_inbox_purge_idx`). Строки не удаляются (`DELETE` `crm_app` на эту
таблицу не выдан; к 01.11 не нужно).

### 7.8. Beeline (заготовка)

`telephony.beeline`: `flag: 'TELEPHONY_BEELINE'`, `licenseFeature: 'telephony.beeline'`, `crossBorder: false`,
`needsConnection: true`, `configSchema` и `secretsSchema` — `z.object({}).strict()`, `healthCheck → not_configured`,
`initiateCall → {kind:'error', code:'no_endpoint'}`, без `webhook`. В админке карточка «Beeline ВАТС: ждём
документацию провайдера» без кнопок. Вопросы к Beeline — INTEGRATIONS §2.3.

---

## 8. O7a: `messenger.wazzup` за `FEATURE_WAZZUP` (D-270, D-271, D-297…D-299)

### 8.1. Файлы

| Файл | Поток | Что |
|---|---|---|
| `src/integrations/messenger/wazzup/{index,api,verify,split,parse,schemas,types}.ts` | ops | плагин |
| `tests/integrations/messenger.wazzup/fixtures/*.json` | ops | синтетика: тест, входящее, эхо, правка, удаление, `missing_call`, картинка, статусы, `channelsUpdates` с `qr`, неизвестный ключ |
| `src/server/domain/messenger/{types,repo,apply,resolve,chatWindow,consent,index}.ts` | ops | применение событий, окно чата, согласие |
| `src/server/domain/intake/inbound.ts` | base (пишет builder O7a, ревью оркестратора base) | новый клиент из входящего |
| `src/server/domain/distribution/inbound.ts` | base (то же) | владелец карточки по `distribution.inbound` |
| `src/server/domain/timeline/kinds.ts`, `timeline/repo.ts` | calling | виды `message`, `messenger.link_opened`; текст сообщения при чтении ленты |
| `src/app/api/messenger/chat-window/[cardId]/route.ts`, `…/opened/route.ts`, `…/consent/route.ts` | ops | маршруты |
| `src/ui/messenger/ChatPanel.tsx`, `ConsentToggle.tsx` | ops | панель чата в карточке |
| кнопка «WhatsApp» карточки C8 (`src/app/(op)/clients/…`) | calling | вызывает `chatAction` |
| `deploy/nginx/crm.conf.template`, `scripts/crmctl/{install,update}.ts` | ops | CSP `frame-src` (§8.8) |

### 8.2. Клиент API (`api.ts`)

База `https://api.wazzup24.com/v3`, `createHttp(['api.wazzup24.com'])`, `Authorization: Bearer <apiKey>`, таймаут
10 с; 429 и 5xx → один повтор через 1 с, дальше код. Методы: `getChannels()`; `patchWebhooks(uri)` — **полный**
объект `subscriptions: {messagesAndStatuses: true, channelsUpdates: true, contactsAndDealsCreation: false,
templateStatus: false}`; `postUsers([{id, name}])` (без телефона); `postIframe({user:{id,name}, scope:'card',
filter:[{chatType, chatId}], activeChat?: {channelId, chatType, chatId}, options:{useDealsEvents:false,
useMessageEvents:false}})`. Ошибки → `HealthCode` (`401` → `auth`, сеть и 5xx → `provider_down`, иное →
`rejected`). Тела ответов и ключ не логируются. `healthCheck` = `getChannels()` успешен и каналов ≥ 1 → `ok`,
0 → `no_channels`.

### 8.3. Подключение и включение (D-270)

1. **Подключить** (§7.5): ключ → `GET /channels` → каналы на экране (номер канала компании, состояние).
   Провайдеру уходит только ключ — ПДн не уходят. На экране рекомендация: отдельный аккаунт Wazzup под CRM
   (подписка на вебхуки одна на аккаунт).
2. **Отметить решение ЦРП о передаче за рубеж** (`crossborder`, с датой документа).
3. **Привязать каналы** к операторам или оставить общими и **включить** нужные: каналы приходят выключенными
   (D-298), сообщения выключенного канала CRM не принимает.
4. **Включить**: токен → `PATCH /webhooks` (Wazzup шлёт `{"test":true}` — §7.6 п. 5) → `POST /users` (сотрудники
   пространства: id и имя) → `enabled=true`. Новые и переименованные сотрудники досылаются лениво: перед каждым
   открытием окна чата `syncUsers([viewer])` (идемпотентно по id) — модуль team не трогаем.
5. В production флаг выключен до решения ЦРП (D-026, PLAN §7.3): весь блок Wazzup скрыт.

### 8.4. Вебхук: verify, split, parse

- `verify`: не `POST` или тело не объект → `bad_body`; `json.test === true` → `{ok:true, test:true}`; иначе
  `{ok:true, test:false}` (подлинность — токен пути + принадлежность канала + лимиты, INTEGRATIONS §3.2; сверка
  `crmKey` в `Authorization` добавляется сюда, когда песочница подтвердит, что его можно задать).
- `split`: `messages[]` → `kind:'message'`, ключ `m:<messageId>:<isEdited?1:0>:<isDeleted?1:0>`, у правки (не
  удаления) — `m:<messageId>:1:0:<отпечаток>`, отпечаток — первые 16 hex `sha256(messageId + "\n" + text)` (D-299: у
  Wazzup нет id правки; каждая правка — своя строка, повтор той же — тот же ключ, текста в ключе нет); `statuses[]` →
  `s:<messageId>:<status>`; `channelsUpdates[]` → `c:<channelId>:<state>:<timestamp>`. Из payload выбрасываются
  `qr`, `contact.avatarUri`, `contentUri`, `quotedMessage`, `oldInfo`. `messageId`/`channelId` не по формату
  `^[A-Za-z0-9-]{1,64}$` — строка пропускается. Прочие ключи тела (`createContact`, `templateStatus` …) — пусто.
- `parse` (чистая; Zod-схемы `.passthrough()` из `schemas.ts`): `isEcho → direction`; `chatType === 'whatsapp'` →
  `chatDigits = normalizeKzDigits(chatId)` (`src/shared/tel.ts`), иначе `''`; `type` → `msgType` (`missing_call`,
  `text`, медиа → `image|audio|video|document` с `hasAttachment`, остальное `other`); `text` ≤ 4096; `dateTime`
  ISO → epoch; `authorId → authorRef`; `contact.name` ≤ 200 → `contactName`; `state` — нижний регистр.
  Неизвестное — `[]`.

### 8.5. Применение (`domain/messenger/apply.ts`)

`applyMessengerEvents(actor: SystemActor, deps: {registry, now}, {integrationId, events}): Promise<QueueOutcome>` —
одна тх на строку inbox. Событие мессенджера **никогда** не меняет состояние карточки и не снимает «Не звонить».

```
integ = SELECT … FROM integrations WHERE id = $id FOR SHARE; не enabled → done (событие сбрасывается)
для каждого события:
  channel = messenger_channels (integration_id, provider_channel_id = ev.channelRef)
    нет → не чаще раза в 5 мин на подключение (память процесса) listChannels() и upsert (новые каналы —
          is_enabled = false, уведомление messenger_channel_new администраторам, dedupe 'mchnew:<channelId>:<user>',
          D-298); снова нет → событие пропускается, счётчик foreign_channel (INTEGRATIONS §3.2 п. 3)
  channel: UPDATE state, state_changed_at = ev.at WHERE state_changed_at IS NULL OR state_changed_at <= ev.at;
           state ≠ 'active' и канал включён → уведомление messenger_channel_down {state} администраторам и РОП,
           dedupe 'mch:<channelId>:<state>:<день>'
  status:  UPDATE messenger_messages SET status, status_at WHERE integration_id AND provider_message_id
           AND (status_at IS NULL OR status_at <= ev.at); 0 строк → retry (сообщение ещё не пришло), с 3-й попытки done
  message:
    канал выключен → событие пропускается (ни чата, ни клиента, ни текста, ни задач), счётчик channel_disabled (D-298)
    chat = INSERT messenger_chats (channel_id, chat_type, chat_id) ON CONFLICT (channel_id, chat_type, chat_id)
           DO UPDATE SET chat_id = EXCLUDED.chat_id RETURNING id, client_id
    chat.client_id пуст и chatDigits ≠ '' → resolveClient (§8.6) → UPDATE messenger_chats SET client_id
    msg = INSERT messenger_messages … ON CONFLICT (integration_id, provider_message_id) DO UPDATE SET
            is_edited = m.is_edited OR EXCLUDED.is_edited, is_deleted = m.is_deleted OR EXCLUDED.is_deleted,
            body = CASE WHEN EXCLUDED.is_deleted THEN NULL WHEN EXCLUDED.is_edited THEN EXCLUDED.body ELSE m.body END,
            status = COALESCE(EXCLUDED.status, m.status)
          RETURNING id, (xmax = 0) AS inserted
    не inserted → дальше ничего (повтор или правка)
    клиента нет → только чат и сообщение (лента и задачи не создаются)
    card = cards (client_id, channel.space_id); worker = card.acting ?? card.owner ?? lead(space)
    client_events: kind 'message', ref_type 'messenger_message', ref_id msg.id,
                   data {direction, msgType, hasAttachment}; actor_id = users.id, если authorRef — наш сотрудник
    UPDATE messenger_chats SET last_message_at, last_inbound_at (для входящего)
    direction 'in':
      msgType missing_call → ensureAutoTask(missed_call, kind call, key 'missed:wa:<msg.id>', assignee worker)
      клиент «Не звонить» (card.state = do_not_call или номер чата в stop_list) →
          ensureAutoTask(dnc_inbound, kind check, key 'dnc_inbound:<clientId>', assignee lead)
      иначе, если задач inbound_message по подключению за сутки < 500 →
          ensureAutoTask(inbound_message, kind message, key 'reply:<chat.id>',
                         due = at + tasks.inboundReplyMinutes, assignee worker); awaiting_reply = true
      лимит исчерпан → без задачи, уведомление messenger_flood {limit} РОП и админам (dedupe на сутки)
    direction 'out': closeAutoTaskByKey('reply:<chat.id>'); awaiting_reply = false
```
`lead(space)` — первый по `(users.name, id)` активный сотрудник с ролью `distribution.inbound.offHours` (ЦРП: `rop`).
Новых `tasks.source` не нужно: `inbound_message`, `missed_call`, `dnc_inbound`, `review` есть в v1.

### 8.6. Клиент по номеру (D-271)

`resolveClient(tx, actor, {spaceId, digits, direction, contactName, integrationId, channel})` (`resolve.ts`):
- клиенты с `client_phones.digits = $digits` (слитые — по `merged_into_id` к выжившему), различные:
  - 1 → он;
  - > 1 → с наибольшим `cards.last_touch_at` в пространстве + `ensureAutoTask(review, kind check,
    key 'review:chat:<chat.id>', assignee lead)`;
  - 0 и `direction='in'` → **новый клиент** (ниже);
  - 0 и `direction='out'` → `null` (оператор написал с телефона на новый номер — клиента не создаём).

`createInboundClient(tx, actor, {spaceId, sourceKey, digits, contactName, preferredUserId})` (`intake/inbound.ts`,
та же тх):
1. `lockIntake(tx)` (D-022); повторный поиск номера под блокировкой (гонка двух вебхуков);
2. номер в `stop_list` (`phoneHmac`) → клиента не создаём, уведомление `messenger_dnc_unknown` lead; `null`;
3. лимит 200 новых клиентов в сутки на подключение: `count(*) FROM client_sources WHERE source_key = $sourceKey
   AND first_seen_at >= <начало суток>` → исчерпан: `null` + `messenger_flood`;
4. `clients` (`name = contactName || formatKzPhone(digits)`, `name_norm`/`search_norm` — функции intake),
   `client_phones` (вид по префиксам `phone.*`, основной), `client_sources (source_kind 'messenger', source_key =
   $sourceKey)`, карточка `new` в `spaceId`; лента `client.created {sourceKind:'messenger'}`, `card.created
   {sourceKey}`;
5. `assignInbound(tx, actor, {spaceId, cardId, preferredUserId: channel.owner_user_id, now})`
   (`distribution/inbound.ts`, правило `channel_owner_then_least_loaded`): владелец канала — активный участник
   раздачи (`in_distribution`, не «Пауза», не «Отсутствует» сегодня) → он; иначе в рабочее время
   (`calendar.isWorkday(today)` и `workHours`) → участник с наименьшим числом выдач сегодня (`assign_cap_idx`,
   ничья — по id); иначе карточка остаётся в пуле (раздаст тик), задачу получает lead. Запись: `UPDATE cards SET
   owner_user_id, assigned_at, touched_in_crm = TRUE` + `assign_log kind 'inbound', counts_to_cap = capIncludes ∋
   'inbound'` + лента `card.assigned {toUserId, mode:'inbound'}`.

`sourceKey` — `integrations.config.sourceKey`, по умолчанию первый источник `sources[]` с `kind: messenger`
(ЦРП: `whatsapp_in`). Нет такого источника → `failed invalid_settings` (видно администратору).

### 8.7. Окно чата в карточке

`POST /api/messenger/chat-window/[cardId]` — `route({perm:'note.write', target:'object'})` (D-297: окно — пишущее
действие, сотрудник пишет клиенту от имени компании; «только чтение» и запирающая лицензия — 423 в обёртке, ни
`syncUsers`, ни `/iframe`), лимит 30 в минуту на сотрудника:
1. карточка `WHERE c.id = $id AND S('card','note.write')` → нет → `404` (чужое = несуществующее);
1а. последняя отметка `consents` клиента карточки (охват — та же карточка, `note.write`) = `revoked` → `409
   consent_revoked`, провайдер не вызывается;
2. пригодное подключение `messenger.wazzup` пространства карточки → нет → `409 messenger_unavailable`;
3. номер: основной рабочий мобильный клиента, видимый роли → нет → `409 no_phone`;
4. канал: включённый канал владельца (`acting ?? owner`), иначе канал самого `viewer`, иначе общий (`owner_user_id
   IS NULL`); среди равных — `state='active'` первым → нет → `409 no_channel`;
5. `syncUsers([{id: viewer.userId, name}])`, затем `openChat(ctx, {user, chat:{chatType:'whatsapp', chatId: digits,
   digits}, channelRef, text:null})` — **без имени клиента** (D-270) → `iframe` или `502 provider_error`;
6. аудит `messenger.open_chat` (entity `messenger`, entityId = cardId, meta `{channelId}`);
7. ответ `{url}`; `Cache-Control: no-store` (обёртка); URL не пишется ни в логи, ни в аудит.

Интерфейс: кнопка «WhatsApp» карточки → `chatAction` → `panel`: `ChatPanel` (на телефоне — `BottomSheet` на всю
высоту, на ноутбуке — боковая панель 480 px) с `<iframe src={url} allow="clipboard-write *"
referrerPolicy="no-referrer" title=…>` (без микрофона, D-299: `Permissions-Policy microphone=()` остаётся) и ссылкой «Открыть в новой вкладке» (`target="_blank" rel="noopener
noreferrer"`). Ссылка не сохраняется (новая на каждое открытие). Рядом — `ConsentToggle`.

**Согласие** (INTEGRATIONS §3.2 п. 12): `POST /api/messenger/consent {clientId, action:'given'|'revoked'}` —
`route({perm:'client.edit', target:'object'})`, клиент по `S('client','client.edit')` → `consents (kind
'messenger_crossborder', action, text_hash = sha256 текста messages/ru `messenger.consent.text`)`. Окно чата без
отметки **открывается** с предупреждением «Согласие не отмечено» (вопрос владельцу §14 п. 4); при последней отметке
«отозвано» окно не открывается (D-297): сервер — `409 consent_revoked`, панель ссылку не запрашивает и показывает
текст; новая отметка согласия в панели запрашивает окно заново.

### 8.8. CSP (ops)

`deploy/nginx/crm.conf.template`: в CSP добавить `frame-src $crm_frame_src;`, перед ним `set $crm_frame_src
"'none'";` и `include /etc/crm/nginx-csp.d/*.conf;`. `crmctl install` и `update` пишут
`/etc/crm/nginx-csp.d/frame.conf` (`set $crm_frame_src "https://*.wazzup24.com";`) **только** при `FEATURE_WAZZUP=1`
в `app.env`, иначе удаляют файл; затем `nginx -s reload`. Полный список доменов iframe — с песочницы до включения
(INTEGRATIONS §3.2).

### 8.9. Лента

- `timeline/kinds.ts`: `message: {group:'messages', dataKeys:['direction','msgType','hasAttachment']}`,
  `'messenger.link_opened': {group:'messages', dataKeys:['templateKey']}`.
- `timeline/repo.ts`: для `kind='message'` — `LEFT JOIN messenger_messages m ON m.id = e.ref_id`, в ответ `text:
  m.body` (удалённое — `null`, UI: «сообщение удалено») и `status: m.status`. Охват — тот же, что у ленты клиента.
- UI сворачивает сообщения дня в «Переписка: N сообщений» (PROCESS 9.1), раскрытие — списком.

---

## 9. Реестры: права, аудит, уведомления, лента, флаги

| Реестр | Добавить |
|---|---|
| `PERMISSIONS` (ядро) | `export.journal` (read, minScope space) |
| `AuditEntity` | `export`, `integration`, `messenger` |
| `AUDIT_ACTIONS` | `export.report`, `export.full`, `export.guests`, `export.full_done` (D-294), `integration.connect`, `integration.crossborder`, `integration.enable`, `integration.disable`, `integration.revoke_webhook`, `integration.channel`, `messenger.open_chat` |
| `notifications.kind` (тексты `notify.json`) | `export_full_done`, `messenger_channel_down`, `messenger_channel_new`, `messenger_flood`, `messenger_dnc_unknown`, `integration_inbox_failed` |
| `EVENT_KINDS` | `message`, `messenger.link_opened` |
| `OUTCOME_VIAS` | `manual_entry` |
| Флаги | `FEATURE_REPORTS` (§1, §2.3, §3) и `FEATURE_SALES_SETTINGS` (§5) — D-295; прежние: `FEATURE_KANBAN`, `FEATURE_REPORTS_EXPORT`, `FEATURE_WAZZUP`, `FEATURE_TELEPHONY_BEELINE`. Полная выгрузка и журнал — без флага (D-055, D-295) |
| Пресет ЦРП | директору `export.journal` |

---

## 10. Тексты (`messages/ru/*.json`; только локали, паритет ключей)

- `reports.json`: `period.{today,yesterday,thisWeek,lastWeek,thisMonth,lastMonth,custom,from,to,invalid}`,
  `tabs.{operators,funnel,revenue,attendance,reasons}`, `operators.cols.*`, `operators.belowTarget` («ниже нормы»),
  `funnel.{steps.*,byOperator,bySource,hint}`, `revenue.cols.*`, `attendance.{by.*,cols.*}`, `reasons.groups.*`,
  `export.{csv,xlsx,cols.*,yes}`, `full.{button,title,lead,password,submit,errors.{password_invalid,export_limit,
  busy,rate_limited}}`, `journal.{title,cols.*,kind.*,empty}`, `director.{title,tiles.*,prevWeek,more,stockDays}`.
- `deals.json`: `board.{title,tabs.{sales,calling},owner,all,closed,showClosed,more,moveTo,moved,undo,needBooking,
  needAttendance,panelTitle,conflict,noNetwork,stale,rebook,cannotBack,closedTile}`, `board.calling.{cols.*,
  manualEntry}`.
- `settings.json`: `sales.{title,dailyCap,schedule,callWindow,callsPerHourTarget,targetNone,hints.*,save,saved,
  conflict,invalid}`, `holidays.{title,add,holiday,workday,note,remove,adminOnly}`.
- `integrations.json`: `list.*`, `state.{flag_off,not_licensed,disabled,crossborder_not_approved,usable}`,
  `wazzup.{connect,apiKey,channels,ownerPool,crossborder.*,enable,disable,rotate,recommendAccount,lastEvent,noKey}`,
  `beeline.waiting`, `health.*`.
- `messenger.json`: `chat.{open,newTab,unavailable,noPhone,noChannel,providerError,consentMissing}`,
  `consent.{text,given,revoked}`, `feed.{message,folded,deleted,attachment,linkOpened}`.
- `notify.json`: тексты новых видов (§9), без имён клиентов.
- `shell.json`: `nav.{director,integrations,exports}`.

Подписи этапов, причин, типов услуг и источников — из настроек (`label.ru`), не из локалей.

---

## 11. Тесты

**Unit** (`tests/unit/…`):
- `reports/period.test.ts` — границы суток Asia/Almaty (23:30 и 00:30 местного), 92/93 дня, `from > to`, неделя с
  понедельника, `to` = завтра и послезавтра.
- `reports/definitions.test.ts` — `rate` (0 → null, 1 знак), `callsPerHour` (0 ч → null), корзины недель.
- `reports/exportTable.test.ts` — колонки каждого отчёта; строки `=SUM(A1)`, `+7 709…`, `-5`, `@x` экранируются.
- `platform/files-zip-write.test.ts` — запись → `readZipDirectory` + `inflateEntry` читают; CRC; UTF-8 имя; предел.
- `platform/files-xlsx-write.test.ts` — круговой тест через `readXlsx`: значения и числа; `=1+1` осталось текстом
  (`inlineStr` + `quotePrefix`); запрещённые XML-символы вырезаны; 32 767.
- `platform/secrets.test.ts` — seal/open; чужие `integrationId`/`name` → `auth_failed`; неизвестный kid; порча тега;
  production без ключа → `no_key`; ротация.
- `integrations/enablement.test.ts` — матрица `PluginGate` × плагины.
- `integrations/registry.test.ts` — уникальность, флаги из `FEATURES`; `manual` → `tel:+7…`, `wa_link` →
  `https://wa.me/7…?text=…`.
- `integrations/wazzup-split-parse.test.ts` — на фикстурах: тест, вход/эхо, правка/удаление (разные ключи),
  `missing_call`, медиа, статусы, каналы с `qr` (выброшен), чужие ключи, плохой `messageId`, > 500 строк.
- `deals/board-rules.test.ts` — `missingFor` по `requires` этапов ЦРП и `base`.
- `deals/calling-drop-rules.test.ts`; `admin/sales-settings-paths.test.ts` — белый список, неверные значения.
- `layers.test.ts` — `telHref`/`waHref` в `src/ui/**` вне `dial.ts`/`openChat.ts` — ошибка.
- `config/preset-export-roles.test.ts` (§2.3).

**Интеграционные** (Postgres, `tests/integration/…`):
- `reports/period-reports.test.ts` — синтетика за 3 дня у границы суток: перенос записи (одна запись), отмена
  `operator_error` (не считается), импортная запись (не в «Записях», но в явке), покупка автору первой записи и
  владельцу без записи, первый «ЛПР да», повторная покупка, источник; фильтры `users`, `source`; оператор → 403;
  директор → 200.
- `reports/director.test.ts` — неделя и прошлая неделя; запас; **директор: каждый мутирующий маршрут манифеста →
  423**, кроме выгрузок и D-054.
- `reports/export.test.ts` — CSV/XLSX заголовки; `Sec-Fetch-Site: cross-site` → 403; XLSX при выключенном флаге →
  404; строка журнала с белым списком `meta` без значений; директор выгружает; лицензия `read_only` — работает.
- `reports/full-export.test.ts` — неверный пароль → 403 и нет билета; билет одноразовый, 60 с, чужой → 404;
  архив: `manifest.json`, таблицы; нет `password_hash`, `iin_hmac`, секретов, скрытого поля; уведомления директору,
  РОП, админам; журнал; лимит 3 в сутки; администратор без роли → 403; `read_only` — работает.
- `reports/journal.test.ts` — админ видит всё, директор — своё пространство, РОП → 403.
- `deals/board.test.ts` — колонки, 50 + «ещё», фильтр владельца, `missing`, «залежалось», закрытые за 30 дней,
  скрытое поле не в ответе, флаг выключен → 404.
- `deals/calling-board.test.ts` — состояния, пул не попадает, итог `manual_entry` через `/api/calls/outcomes`
  меняет колонку, у директора — 423.
- `admin/sales-settings.test.ts` — ревизия `source=ui` с `note`; 409 при старой ревизии; 400 с путями; РОП не
  правит праздники (403), админ правит; оператор 403; следующий тик раздачи читает новый лимит.
- `integrations/webhook.test.ts` — неизвестный токен 404; выключенная — 404, но `{"test":true}` 200 без записи;
  повтор не задваивает `webhook_inbox`; 256 КБ + 1 → 413; `last_event_at` раз в минуту.
- `integrations/admin.test.ts` — connect (фикстуры http), enable без отметки решения → 409, с отметкой — подписка и
  пользователи; disable в `read_only` работает (D-054); секрет в БД не равен ключу; `last4`.
- `messenger/apply.test.ts` — через обработчик очереди на фикстурах: неизвестный номер → клиент, карточка у
  владельца канала / наименее загруженного / в пуле вне часов, задача «Ответить»; второе входящее — без второй
  задачи; эхо закрывает задачу; «Не звонить» → задача РОП, **состояние карточки до и после одинаково**; два клиента
  с номером → задача «проверить»; чужой канал → пропуск; статус раньше сообщения → retry → применён; правка и
  удаление; лимиты 200 и 500.
- `messenger/chat-window.test.ts` — чужая карточка → 404 (оператор B); флаг выключен / нет подключения → 409;
  в запросе к провайдеру нет имени клиента; аудит; ссылки нет в `console.*` (шпион).

**Изоляция** (`tests/isolation/manifest/`): `reports.ts` (+ период, выгрузки, директор), `export.ts`, `kanban.ts`,
`settings.ts`, `integrations.ts`, `messenger.ts`, `hooks.ts` (публичный вебхук: чужой токен ничего не пишет).
Каждый новый маршрут и страница — запись манифеста; прогон на пресетах ЦРП и `base`.

**E2E** (`pixel-7`; сценарии телефона — ещё `iphone-13`): `reports-period.spec.ts` (РОП: период, таблица, скачивание
CSV — событие `download`; директор видит строку в журнале); `deals-board.spec.ts` («Переместить в…» → «Отменить» за
5 с — на сервере без изменений; второй перенос сохранён; перенос в «Переговоры» без задачи → панель «следующий
шаг»); `calling-board.spec.ts` («Переместить в… Перезвон» → шторка → пресет → карточка в колонке);
`director.spec.ts` (панель, нет кнопок изменения); `settings.spec.ts` (лимит сохранён; конфликт ревизий);
`messenger-off.spec.ts` (флаг выключен — кнопка WhatsApp открывает `wa.me`, окна чата нет).

---

## 12. Миграции

**Не нужны.** Всё ложится на схему v1: `calls.via` уже допускает `manual_entry`; `tasks.source` — `inbound_message`,
`missed_call`, `dnc_inbound`, `review`; `assign_log.kind` — `inbound`; `client_sources.source_kind` — `messenger`;
таблицы `integrations`, `integration_secrets`, `webhook_inbox`, `messenger_*` есть; журнал выгрузок — `audit_log`
(`audit_log_action_idx`). Возможные индексы после нагрузки — §1.4 (решает architect по итогам Q1c).

---

## 13. Задачи и порядок

| № | Задача | Поток | Ур. | Кто | Зависит | Срок |
|---|---|---|---|---|---|---|
| R2b | §5 настройки продаж: сервис, API, экран, тесты | manager | T1 | builder | P5 | 26.10 12:00 (иначе 0.9.1) |
| O6-1 | §7.2–7.3: `registry`, `enablement`, `http`, `manual`, `wa_link`, `beeline`; `modes.ts`, `ChannelModesProvider`, `dial.ts`/`openChat.ts`, перевод CallCard/CallButton/напоминаний; ESLint и `layers.test` | ops (+calling для UI) | T2→T1 | builder | сигнатуры готовы | 27.10 |
| O6-2 | §7.4 секреты + `crmctl secrets rotate` (это O5) | platform/ops | T2→T1 | builder → reviewer | — | 27.10 |
| O6-3 | §7.5–7.7 подключения, вебхук, обработчик очереди, чистка `payload`, экран `/integrations` | ops | T1 | builder | O6-1, O6-2 | 27.10 |
| R3a-1 | §1.2–1.4 `period`, `definitions`, `periodRepo`, сервисы, `getReport`, API | manager | T2→T1 | builder | R1b | 27.10 |
| R3a-2 | §1.5 экран `/reports` | manager | T1 | builder | R3a-1 | 27.10 |
| O7a-1 | §8.2, §8.4 плагин Wazzup: api, verify, split, parse, фикстуры, unit | ops | T1 | builder | O6-1 | 27.10 |
| O7a-2 | §8.5–8.6, §8.9 `messenger/apply`, `resolve`, `intake/inbound`, `distribution/inbound`, лента | ops (+base, calling) | T2→T1 | builder → reviewer | O6-3, O7a-1 | 28.10 |
| O7a-3 | §8.3, §8.7 включение, окно чата, согласие, `ChatPanel`, кнопка в карточке | ops (+calling) | T1 | builder | O7a-2 | 28.10 |
| O7a-4 | §8.8 CSP через `crmctl` | ops | T1 | builder | — | 28.10 |
| R3b-1 | §2.2 `zipWrite`, `xlsxWrite`, `looksLikeFormula` | platform | T1 | builder | — | 28.10 |
| R3b-2 | §2.3–2.4, §2.6 выгрузка отчёта, журнал, `export.journal` в каталоге и пресете | manager (+platform) | T1 | builder → reviewer (права) | R3a-1, R3b-1 | 28.10 |
| R3b-3 | §2.5 полная выгрузка | manager | T2→T1 | builder → reviewer | R3b-2 | 28.10 |
| B8-1 | §4.2–4.3 доска продаж, `missingFor`, `fieldsPatch` | booking | T1 | builder | B6 | 29.10 |
| B8-2 | §4.4 вид «Обзвон», `OUTCOME_VIAS` + `manual_entry` | booking (+calling) | T1 | builder | B8-1 | 29.10 |
| R4 | §3 панель директора | manager | T1 | builder | R3a-1 | 29.10 |
| M-1 | §6 меню | manager | T0 | mechanic | R4, O6-3, R3b-2 | 29.10 |
| BK-g | выгрузка списка гостей пишет `export.guests` через `writeExportLog` | booking | T0 | mechanic | R3b-2 | 29.10 |
| R3a-5 | сводка R1a на определения §1.3 (ЛПР «первый», записи — головы цепочек) | manager | T1 | builder | R3a-1 | 0.9.1 |
| Q | изоляция §11 для всех новых маршрутов и страниц, e2e pixel-7 | — | T1 | tester | по мере влития | 30.10 |

Порядок: R2b (25.10) → O6-1 ∥ O6-2 ∥ R3a-1 ∥ O7a-1 (27.10) → O6-3, R3a-2 → O7a-2 ∥ R3b-1 → R3b-2 → R3b-3 ∥ O7a-3 ∥
O7a-4 (28.10) → B8-1 → B8-2 ∥ R4 → M-1, BK-g (29.10) → Q (30.10). Перед пушем каждого PR — `reviewer`; секреты,
полная выгрузка, вебхук и окно чата — ещё и в ревью безопасности Q2b. Резка при отставании — PLAN §6.3: XLSX
(остаётся CSV), панель директора; канбан и Wazzup — только решением владельца.

---

## 14. Вопросы владельцу (до ответа работаем по рекомендации)

1. **Покупка в отчёте «Операторы»** засчитывается автору первой записи сделки (записи нет — владельцу сделки)?
   Рекомендую **да**: «кто записал — тот привёл покупку» (PROCESS 5.6). (D-261)
2. **Полная выгрузка** — ZIP с CSV по таблицам и настройками, не больше 3 раз в сутки на сотрудника? Рекомендую
   **да**. (D-264)
3. **Праздники** правит только администратор (CONFIG §5), РОП видит список? Рекомендую **да**; если у ЦРП РОП — не
   администратор, дать ему признак администратора. (D-267)
4. **Wazzup и согласие клиента**: окно чата открывается без отметки согласия (с предупреждением) или только после
   неё? Рекомендую **без блокировки**: Wazzup и так выключен до письменного решения ЦРП о передаче ПДн (В-9), а
   переписку чаще начинает сам клиент. Вопрос передать ЦРП вместе с В-9. (D-270)
