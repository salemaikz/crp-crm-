-- Лицензия: часы позади (D-306, ARCHITECTURE §8.4). Пока часы сервера отстают от last_seen_at больше чем на
-- 10 минут, время лицензии идёт по монотонному времени процесса и по ходу самих часов; часы позади дольше 48 ч —
-- «только чтение» с причиной clock. Чтобы перезапуск процесса не замораживал время, между пересчётами хранится:
--   clock_real_at       — оценка времени без шагов вперёд (D-212); NULL — равна last_seen_at;
--   clock_behind_since  — last_seen_at в начале эпизода «часы позади»; NULL — эпизода нет;
--   clock_behind_last   — показание часов на прошлом пересчёте в эпизоде; NULL — эпизода нет.
-- ПДн нет. Добавляющая и идемпотентная правка; прежние версии новые колонки не читают (D-059, D-060).
ALTER TABLE license_state ADD COLUMN IF NOT EXISTS clock_real_at BIGINT;
ALTER TABLE license_state ADD COLUMN IF NOT EXISTS clock_behind_since BIGINT;
ALTER TABLE license_state ADD COLUMN IF NOT EXISTS clock_behind_last BIGINT;
