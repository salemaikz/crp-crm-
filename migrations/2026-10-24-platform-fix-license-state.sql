-- Лицензия (P10, ARCHITECTURE §8.4, D-029, D-211): начало льготы `invalid` и код причины состояния.
-- invalid_since — момент, когда рабочая лицензия перестала сходиться (льгота 7 дней считается от него
-- и не продлевается перезапуском); NULL — льготы нет. reason — код без текста (bad_signature, expired …)
-- для `crmctl license status` и тревоги. checked_at с P10 — момент последнего шага last_seen_at по часам.
-- Добавляющая и идемпотентная правка; схема v1 не правится (D-059).
ALTER TABLE license_state ADD COLUMN IF NOT EXISTS invalid_since BIGINT;
ALTER TABLE license_state ADD COLUMN IF NOT EXISTS reason TEXT NOT NULL DEFAULT '';
