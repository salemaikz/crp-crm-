-- Web-push (P8b, D-328): подписка устройства привязана к сессии, которая её создала; переключатель push и отметка
-- решения клиента о зарубежных push-сервисах. Дизайн — docs/push-banner-design.md §2.2.
--   push_subscriptions.session_id — sessions.id (sha256 токена), без FK: строка сессии удаляется при выходе, а подписка
--     и её строки очереди остаются до чистки. Push уходит, только пока эта сессия жива (общий телефон: вышел — не
--     получает). NULL — подписка до этой миграции: не рассылается никогда.
--   push_settings — одна строка: включено ли и кто когда отметил письменное решение клиента. Нет строки — выключено.
-- ПДн нет. Добавляющая и идемпотентная правка; прежние версии новые колонку и таблицу не читают (D-059, D-060).
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS session_id TEXT CHECK (session_id ~ '^[0-9a-f]{64}$');
CREATE INDEX IF NOT EXISTS push_subscriptions_session_idx ON push_subscriptions (session_id) WHERE disabled_at IS NULL;

CREATE TABLE IF NOT EXISTS push_settings (
  id                      INTEGER PRIMARY KEY CHECK (id = 1),
  enabled                 BOOLEAN NOT NULL DEFAULT FALSE,
  crossborder_approved_at BIGINT,            -- отметка «есть письменное решение клиента о push через Apple и Google»
  crossborder_approved_by TEXT REFERENCES users(id),
  updated_at              BIGINT NOT NULL,
  updated_by              TEXT REFERENCES users(id),
  CHECK (NOT enabled OR crossborder_approved_at IS NOT NULL)
);
