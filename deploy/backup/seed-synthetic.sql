-- Синтетика для учебного восстановления (DEPLOY §6.3). Только выдуманные данные: ни одного настоящего
-- имени, номера или БИН. Применяется после миграций к пустой БД; повторный запуск безопасен.
INSERT INTO spaces (id, key, is_default, enabled, created_at)
VALUES ('drill-space-1', 'drill', TRUE, TRUE, 1700000000000)
ON CONFLICT DO NOTHING;

INSERT INTO users (id, phone_digits, name, is_admin, status, created_at)
SELECT 'drill-user-' || g, '7700000' || lpad(g::text, 4, '0'), 'Тестовый сотрудник ' || g, g = 1, 'active', 1700000000000 + g
FROM generate_series(1, 5) AS g
ON CONFLICT DO NOTHING;

INSERT INTO clients (id, kind, name, name_norm, source_kind, created_at, updated_at)
SELECT 'drill-client-' || g, 'company', 'Тестовая компания ' || g, 'тестовая компания ' || g, 'manual',
       1700000000000 + g, 1700000000000 + g
FROM generate_series(1, 200) AS g
ON CONFLICT DO NOTHING;

INSERT INTO audit_log (id, actor_id, space_id, action, entity, entity_id, created_at)
SELECT 'drill-audit-' || g, 'drill-user-1', 'drill-space-1', 'drill.seed', 'client', 'drill-client-' || g, 1700000000000 + g
FROM generate_series(1, 200) AS g
ON CONFLICT DO NOTHING;

INSERT INTO license_state (id, license_raw, install_id, state, last_seen_at, checked_at)
VALUES (1, '', 'drill-install', 'missing', 1700000000000, 1700000000000)
ON CONFLICT DO NOTHING;
