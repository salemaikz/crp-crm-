// Загрузка данных справки: срез активных настроек пространства зрителя (колонки доски, виды мероприятий, причины).
// Тексты ПДн не содержат; чужих пространств нет — берётся только пространство зрителя.
import type { Viewer } from '@/server/access';
import { loadBoardSettings, parseBoardSettings } from '@/server/domain/cards/boardSettings';
import { getActiveConfig } from '@/server/platform/config/active';
import { buildHelpData, type HelpData, type HelpDoc } from './helpData';

export async function loadHelp(viewer: Viewer, stateLabel: (state: string) => string): Promise<HelpData> {
  if (viewer.spaceId === null) return buildHelpData(parseBoardSettings({}), {}, stateLabel);
  const [board, cfg] = await Promise.all([loadBoardSettings(viewer.spaceId), getActiveConfig()]);
  const space = Object.values(cfg.spaces).find((s) => s.spaceId === viewer.spaceId);
  return buildHelpData(board, (space?.doc ?? {}) as unknown as HelpDoc, stateLabel);
}
