# Нагрузочный прогон Q1c (день 5)

Синтетика: 5 000 карточек (200 из мира изоляции, 800 уже у операторов, 4 000 в пуле), 10 операторов раздачи
(лимит 40 в день), номера `+7 709 …`, компании выдуманные. Скрипт: `tests/load/q1c.test.ts`
(не входит в `test:integration`).

## Железо и среда

4 vCPU Intel Xeon 2,1 ГГц, 15 ГБ ОЗУ, виртуалка; Postgres 16.15 на той же машине (`shared_buffers` 128 МБ,
`work_mem` 4 МБ, `jit=on`). Приложение и база на одной машине, сеть не учтена, поэтому на боевом сервере
цифры будут близкими, но не равными.

## Результаты (3 прогона подряд)

| Критерий | Предел | Результат |
|---|---|---|
| Тик раздачи, 400 выдач (10 × 40) | ≤ 5 с | 66–70 мс |
| Тик параллельно работе 10 операторов (ещё 400 выдач) | ≤ 5 с | 170–200 мс |
| Очередь оператора (лимит 6), 300 запросов, 10 параллельно, p95 | ≤ 300 мс | 21–31 мс (p50 8 мс, максимум 124–151 мс) |
| Итог «Не берёт», 300 штук, p95 | — | 27–37 мс |
| Дедлоки (`pg_stat_database.deadlocks`) | 0 | 0 |
| Журнал Postgres за прогон: `deadlock detected`, `could not obtain lock`, `lock timeout` | нет | нет |

Вывод: все критерии выполнены с большим запасом. Первая запись `deadlock detected` в журнале Postgres
(20.10, база `crm_fd2a`) относится к другому, более раннему прогону, не к Q1c. Причину стоит разобрать отдельно.

## Отчёт «воронка (источники)» за 92 дня

В `period-load` отчёт мигает около 300 мс. Замеры на тех же данных (5 000 карточек, 48 000 звонков):
`funnelBySource` (`src/server/domain/reports/periodRepo.ts:210`) занимает 160–235 мс; `EXPLAIN (ANALYZE, BUFFERS)` — 313 мс,
из них JIT 110 мс (оценка плана 472 000 > `jit_above_cost` 100 000).

Где время (шаги `UNION ALL`):

| Шаг | Время | Причина |
|---|---|---|
| connected (звонки) | ~135 мс | коррелированный подзапрос «первый источник клиента» на каждую из 38 400 строк (115 тыс. буферов) |
| issued (выдачи) | ~130 мс в плане | то же на 5 000 строк плюс сортировка по `card_id` |
| lpr, booked, attended, purchased | 2–20 мс | то же, но строк мало |

Индексов не хватает не на таблице звонков: `calls` читается последовательно за 16 мс, `client_sources_client_idx`
используется. Дорого повторять один и тот же поиск источника тысячи раз.

Предложение (только отчёт, продукт не правился): вычислить «первый источник клиента» один раз и
присоединять, а не искать на каждую строку:

```sql
WITH fs AS (
  SELECT DISTINCT ON (s.client_id) s.client_id,
         CASE WHEN s.source_key <> '' THEN s.source_key ELSE s.source_kind END AS src
    FROM client_sources s ORDER BY s.client_id, s.first_seen_at, s.id)
SELECT COALESCE(fs.src, '') AS src, count(*)::int
  FROM calls ca JOIN cards c ON c.id = ca.card_id AND c.space_id = $1
  LEFT JOIN fs ON fs.client_id = ca.client_id
 WHERE … -- условия шага прежние
 GROUP BY 1
```

Шаг connected: 104 мс -> 35 мс (JIT выключен, результат идентичен текущему на тех же данных). Тот же приём — для остальных
пяти шагов; ожидаемо весь отчёт около 80–100 мс. Дополнительно: `SET LOCAL jit = off` для запросов отчётов
или более высокий `jit_above_cost` (на боевом сервере) уберёт до 110 мс компиляции в тяжёлых планах; в замерах
без `EXPLAIN` разницы между jit on/off не было (165 и 161 мс), поэтому это мера второй очереди.
Индекс `client_sources (client_id, first_seen_at, id)` убрал бы сортировку внутри подзапроса, выигрыш малый.
Новая миграция для переписывания не нужна; решение за `architect`.

Сделано: `funnelBySource` и `callsByUserDay` (фильтр по источнику) считают «первый источник клиента» один раз через CTE
с `DISTINCT ON`. `period-load` на загруженной машине: воронка (источники) 352 -> 74–108 мс, операторы (источник)
308 -> 103 мс; совпадение со старым запросом проверяет тест в `period-load.test.ts`.

## Как повторить

```bash
psql "$ADMIN_URL" -c "CREATE DATABASE crm_q1c"
node packages/core/build.mjs
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/crm_q1c npx tsx --test tests/load/q1c.test.ts
psql "$ADMIN_URL" -c "DROP DATABASE crm_q1c"
```

Журнал Postgres читается из `/var/log/postgresql/postgresql-16-main.log` (`PG_LOG_PATH` меняет путь; нет файла —
проверка идёт только по `pg_stat_database`). План отчёта: `period-load.test.ts` + `EXPLAIN (ANALYZE, BUFFERS)` вокруг
`funnelBySource`.
