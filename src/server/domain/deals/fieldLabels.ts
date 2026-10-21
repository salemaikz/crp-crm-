// Подписи полей сделки для экрана, где итог может сменить этап (встреча консультанта, D-301): только поля из
// требований предложенных этапов и только видимые роли зрителя (CONFIG §6.11, ARCHITECTURE §5.2 п. 8).
import { fields } from '@crm/core';
import type { Viewer } from '@/server/access';
import { fieldViewer, loadClientsConfig } from '@/server/domain/clients';
import { stageFieldLabels } from './rules';
import { loadDealsSettings } from './settings';

/** Ключ → подпись поля сделки; поле, скрытое роли зрителя, и поле вне требований этапов `stageKeys` — отсутствуют. */
export async function stageFieldLabelsFor(
  viewer: Viewer,
  args: { spaceId: string; pipelineKey: string; stageKeys: readonly string[]; now: number },
): Promise<Record<string, { ru: string; kk?: string }>> {
  if (args.stageKeys.length === 0) return {};
  const [settings, cfg] = await Promise.all([loadDealsSettings(args.spaceId, args.now), loadClientsConfig(viewer)]);
  const visible = new Set(fields.visibleKeys(cfg.fields, 'deal', fieldViewer(viewer, cfg)));
  const pipeline = settings.pipelines.find((p) => p.key === args.pipelineKey);
  return stageFieldLabels(pipeline, args.stageKeys, settings.fieldLabels, visible);
}

/** Ключи полей сделки, скрытых роли зрителя: требования этапа их не называют и по ним не отвечают (D-323). */
export async function hiddenDealFieldKeys(viewer: Viewer): Promise<ReadonlySet<string>> {
  const cfg = await loadClientsConfig(viewer);
  return new Set(fields.hiddenKeys(cfg.fields, 'deal', fieldViewer(viewer, cfg)));
}
