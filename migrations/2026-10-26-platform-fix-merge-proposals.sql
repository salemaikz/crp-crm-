-- Слияние (D-257): проигравшая карточка остаётся строкой с задержкой 'merged'; «Предложить контакт» (D-258).
-- Добавляющая и идемпотентная (D-037, D-059): расширение закрытого списка CHECK + индексы.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'cards'::regclass
                  AND conname = 'cards_hold_reason_check' AND pg_get_constraintdef(oid) LIKE '%merged%') THEN
    ALTER TABLE cards DROP CONSTRAINT IF EXISTS cards_hold_reason_check;
    ALTER TABLE cards ADD CONSTRAINT cards_hold_reason_check
      CHECK (hold_reason IN ('','dup_pair','import_conflict','no_working_phone','rule','merged'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS proposals_pending_idx ON proposals (space_id, created_at) WHERE status = 'created';
CREATE INDEX IF NOT EXISTS proposals_client_idx  ON proposals (client_id) WHERE client_id IS NOT NULL;
