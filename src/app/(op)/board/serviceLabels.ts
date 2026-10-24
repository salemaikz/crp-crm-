// Подписи услуг и вариантов покупки из настроек пространства зрителя (D-357): ключи в интерфейс не попадают (услуга без подписи считается неизвестной).
import type { Viewer } from '@/server/access';
import { getActiveConfig } from '@/server/platform/config/active';
import type { ServiceLabels } from '@/ui/board/purchase';

type L = { ru: string };
type Service = { key: string; label?: L; archived?: boolean; variants?: { key: string; label: L; archived?: boolean }[] };

/** Архивные услуги и варианты остаются в подписях: старые покупки по ним должны читаться. */
export async function loadServiceLabels(viewer: Viewer): Promise<ServiceLabels> {
  if (viewer.spaceId === null) return {};
  const cfg = await getActiveConfig();
  const space = Object.values(cfg.spaces).find((s) => s.spaceId === viewer.spaceId);
  const list = ((space?.doc as { serviceTypes?: Service[] } | undefined)?.serviceTypes ?? []) as Service[];
  return Object.fromEntries(list.filter((s) => s.label?.ru).map((s) => [s.key, { label: s.label!.ru, variants: Object.fromEntries((s.variants ?? []).map((v) => [v.key, v.label.ru])) }]));
}
