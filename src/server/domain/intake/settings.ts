// Настройки для приёма: глобальный документ и документ пространства ключа.
import type { GlobalConfigV1, SpaceConfigV1 } from '@crm/core/config';
import { getActiveConfig } from '@/server/platform/config/active';
import type { IngestPrincipal } from './types';

export interface IntakeSettings {
  global: GlobalConfigV1;
  space: SpaceConfigV1;
}

/** Нет пространства ключа в настройках: приём закрыт (fail closed). */
export class SpaceUnknownError extends Error {
  override name = 'SpaceUnknownError';
}

export async function intakeSettings(principal: Pick<IngestPrincipal, 'spaceKey'>): Promise<IntakeSettings> {
  const cfg = await getActiveConfig();
  const space = cfg.spaces[principal.spaceKey];
  if (!space) throw new SpaceUnknownError('пространство ключа приёма не найдено в настройках');
  return { global: cfg.global.doc, space: space.doc };
}
