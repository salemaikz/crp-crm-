// Вход «от лица» синтетического сотрудника для прогона и интеграционных тестов: сессия, настройки и
// часы подменяются через src/server/access/testing.ts, Viewer собирается из БД как в бою.
import { buildViewer } from '../../../src/server/access/viewer';
import { overrideAccessForTests, signInForTests } from '../../../src/server/access/testing';
import type { LicenseState, Viewer } from '../../../src/server/access/types';
import { configDoc } from './config';
import { SEED_NOW } from './seed';

export type ActorOptions = { config?: unknown; now?: number; license?: LicenseState };

/** Источники Viewer прогона: пресет клиента, «сейчас» прогона, лицензия действует. */
export function enterSeedWorld(opts: ActorOptions = {}): void {
  const doc = opts.config ?? configDoc();
  overrideAccessForTests({
    config: async () => doc,
    now: () => opts.now ?? SEED_NOW,
    license: async () => opts.license ?? 'valid',
  });
}

/** Войти от лица userId (обёртки route/page/action увидят его сессию). */
export function actAs(userId: string | null): void {
  signInForTests(userId);
}

/** Viewer пользователя, собранный из БД, как на каждом запросе. */
export async function viewerOf(userId: string): Promise<Viewer> {
  signInForTests(userId);
  return buildViewer();
}
