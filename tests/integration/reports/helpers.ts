// Общая подготовка интеграционных тестов сводки: мир изоляции, настройки раздачи и отчётов, часы. Только синтетика.
import { overrideDistributionDepsForTests } from '../../../src/server/domain/distribution/deps';
import { overrideReportsDepsForTests } from '../../../src/server/domain/reports/deps';
import type { Sql } from '../../../src/server/platform/db';
import { DAY, MIN, SEED_NOW, SEED_TODAY, SPACE, U, makeDeps, testConfig, type Clock } from '../distribution/helpers';

export { DAY, MIN, SEED_NOW, SEED_TODAY, SPACE, U };
export { actAs, closeWorld, openDistributionWorld as openWorld, seedPool, viewerOf } from '../distribution/helpers';

/** Часы и настройки сводки: лимит 40, порог просрочки 60 мин, норма 10 звонков в час. */
export function enterReportsConfig(clock: Clock, over: { overdueAlertMinutes?: number; callsPerHourTarget?: number | null } = {}): void {
  // отчёты за период — за FEATURE_REPORTS (D-295); тесты идут как стенд: флаг включён, выключенный проверяется отдельно
  process.env.FEATURE_REPORTS = '1';
  const distribution = testConfig();
  overrideDistributionDepsForTests(makeDeps(clock, distribution));
  overrideReportsDepsForTests({
    config: async () => ({ distribution, overdueAlertMinutes: over.overdueAlertMinutes ?? 60, callsPerHourTarget: over.callsPerHourTarget === undefined ? 10 : over.callsPerHourTarget }),
    now: () => clock.now,
    // колонки доски пресета: «Перезвон» и «Мусор» (блоки отчёта «Причины»)
    reasonColumns: async () => [
      { key: 'callback', label: 'Перезвон', role: 'callback', states: ['retry', 'callback'] },
      { key: 'trash', label: 'Мусор', role: 'trash', states: ['not_interested', 'not_target', 'do_not_call', 'written_off'] },
    ],
  });
}

export function leaveReportsConfig(): void {
  overrideReportsDepsForTests(null);
  overrideDistributionDepsForTests(null);
}

/** Звонок оператора в момент `at`: карточка и клиент уже есть. */
export async function seedCall(
  sql: Sql,
  o: { id: string; cardId: string; clientId: string; userId: string; at: number; kind: string; lpr?: 'yes' | 'no' | ''; via?: string; applied?: 'applied' | 'fact_only' },
): Promise<void> {
  const applied = o.applied ?? 'applied';
  await sql`
    INSERT INTO calls (id, space_id, card_id, client_id, user_id, via, phone_digits, outcome_code, outcome_kind, lpr, applied, fact_reason, occurred_at, received_at, config_rev)
    VALUES (${o.id}, ${SPACE}, ${o.cardId}, ${o.clientId}, ${o.userId}, ${o.via ?? 'ui'}, '', ${o.kind}, ${o.kind}, ${o.lpr ?? ''}, ${applied}, ${applied === 'applied' ? '' : 'stale'}, ${o.at}, ${o.at}, 1)`;
}
