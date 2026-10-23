-- Воронка v2 (docs/pipeline-v2-design.md §3–§6; D-336, D-337, D-338, D-339): причина и касания перезвона,
-- срок без времени, признаки явки и покупок (кэш записей и сделок), горячесть, канал итога «board». ПДн нет.
-- Добавляющая и идемпотентная правка; прежние версии новые колонки не читают (D-059, D-060).
-- Кэш признаков для прежних строк заполняет `crmctl job calling-derived-backfill`, а не миграция: одна копия правил.
ALTER TABLE cards ADD COLUMN IF NOT EXISTS callback_reason TEXT NOT NULL DEFAULT '';      -- ключ reasons.callback
ALTER TABLE cards ADD COLUMN IF NOT EXISTS callback_touches INTEGER NOT NULL DEFAULT 0
  CONSTRAINT cards_callback_touches_check CHECK (callback_touches BETWEEN 0 AND 10000);
ALTER TABLE cards ADD COLUMN IF NOT EXISTS next_call_precision TEXT NOT NULL DEFAULT 'time'
  CONSTRAINT cards_next_call_precision_check CHECK (next_call_precision IN ('time','day'));
ALTER TABLE cards ADD COLUMN IF NOT EXISTS attended_group_at BIGINT;       -- кэш: последняя явка на групповое
ALTER TABLE cards ADD COLUMN IF NOT EXISTS attended_individual_at BIGINT;  -- кэш: последняя явка на консультацию
ALTER TABLE cards ADD COLUMN IF NOT EXISTS last_no_show_at BIGINT;         -- кэш: последняя неявка
ALTER TABLE cards ADD COLUMN IF NOT EXISTS last_no_show_kind TEXT NOT NULL DEFAULT ''
  CONSTRAINT cards_last_no_show_kind_check CHECK (last_no_show_kind IN ('','group','individual'));
ALTER TABLE cards ADD COLUMN IF NOT EXISTS purchases_total INTEGER NOT NULL DEFAULT 0
  CONSTRAINT cards_purchases_total_check CHECK (purchases_total >= 0);
ALTER TABLE cards ADD COLUMN IF NOT EXISTS last_purchase_at BIGINT;        -- кэш: won_at последней выигранной сделки
ALTER TABLE cards ADD COLUMN IF NOT EXISTS heat INTEGER NOT NULL DEFAULT 0
  CONSTRAINT cards_heat_check CHECK (heat BETWEEN 0 AND 100000);           -- = HEAT_MAX ядра

ALTER TABLE calls ADD COLUMN IF NOT EXISTS callback_precision TEXT NOT NULL DEFAULT 'time'
  CONSTRAINT calls_callback_precision_check CHECK (callback_precision IN ('time','day'));
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS due_precision TEXT NOT NULL DEFAULT 'time'
  CONSTRAINT tasks_due_precision_check CHECK (due_precision IN ('time','day'));

-- Канал итога «board»: оператор перенёс плитку без звонка (§3.2). Расширение закрытого списка — добавляющая правка.
-- Новый список — надмножество прежнего, поэтому проверка существующих строк при ADD всегда проходит.
ALTER TABLE calls DROP CONSTRAINT IF EXISTS calls_via_check;
ALTER TABLE calls ADD CONSTRAINT calls_via_check
  CHECK (via IN ('ui','offline','import','telephony','manual_entry','board'));
