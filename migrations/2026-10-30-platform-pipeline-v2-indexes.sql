-- Индексы доски и очереди воронки v2 (docs/pipeline-v2-design.md §6.2, §7.2; D-338, D-350) по итогам нагрузочного
-- прогона C5 на 300 000 карточках (docs/ops/load-pipeline-v2.md). Только индексы: таблицы и данные не меняются, ПДн нет.
-- Добавляющая и идемпотентная правка (D-059). Частичные условия совпадают с предикатами запросов `boardRepo.ts`:
-- `state IN ('retry','callback') AND hold_reason = ''` — колонка «Перезвон», состояния закрытия — колонка «Мусор».
-- Не создаются (прогон показал 0 или ничтожный вклад): индексы горячести со `state` в ключе (два состояния колонки не
-- дают порядок heat), срок огонька по пространству, возврат клиента (№ 34 — с его заданием), `bookings (deal_id, starts_at)`.

-- «Перезвон», часть «огонёк» у своих и временных: срок раньше начала завтрашних суток, диапазон по сроку владельца
CREATE INDEX IF NOT EXISTS cards_fire_owner_idx ON cards (space_id, owner_user_id, next_call_at)
  WHERE state IN ('retry','callback') AND hold_reason = '';
-- «Перезвон», порядок колонки и ключевая пагинация «Ещё» (heat ↓, срок ↑, id): по владельцу (фильтр РОП) и по
-- пространству (РОП, директор). Узкий охват (свои с временными, команда) индекс пространства не читает: boardRepo
-- снимает для него внутренний LIMIT, иначе у оператора без огонька планировщик проходил бы весь индекс (D-350).
CREATE INDEX IF NOT EXISTS cards_cb_owner_idx ON cards (space_id, owner_user_id, heat DESC, next_call_at, id)
  WHERE state IN ('retry','callback') AND hold_reason = '';
CREATE INDEX IF NOT EXISTS cards_cb_space_idx ON cards (space_id, heat DESC, next_call_at, id)
  WHERE state IN ('retry','callback') AND hold_reason = '';
-- «Мусор» за окно recentDays: закрытые по дате закрытия
CREATE INDEX IF NOT EXISTS cards_closed_idx ON cards (space_id, closed_at)
  WHERE state IN ('not_interested','not_target','do_not_call','written_off');
