-- Причина отмены записи «not_target» (docs/booking-design.md §12, M1).
-- Ядро обзвона при итоге «Не целевой» отменяет будущие записи клиента с этой причиной, а список v1
-- её не знал. Расширение закрытого списка CHECK — добавляющая правка (D-037). Схема v1 не правится (D-059).
-- Идемпотентно: ограничение пересоздаётся, только если в нём ещё нет нового значения.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'bookings'::regclass
      AND conname = 'bookings_cancel_reason_check'
      AND pg_get_constraintdef(oid) LIKE '%not_target%'
  ) THEN
    ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_cancel_reason_check;
    ALTER TABLE bookings ADD CONSTRAINT bookings_cancel_reason_check
      CHECK (cancel_reason IN ('', 'client', 'event_cancelled', 'operator_error', 'do_not_call', 'not_target'));
  END IF;
END $$;
