// Как интерфейс звонит и пишет клиенту (D-268, дизайн §7.3): сервер выбирает плагин, клиент строит ссылку сам.
// Телефония — первая пригодная подключённая telephony.* пространства (в порядке реестра), иначе telephony.manual;
// мессенджер — пригодное окно провайдера с включённым каналом пространства, иначе messenger.wa_link.
import type { ChannelModes } from '@/integrations/contract';
import type { Viewer } from '@/server/access';
import { getDb } from '@/server/platform/db';
import { hasEnabledChannel, listSpaceIntegrations } from './repo';
import { usabilityOf } from './service';
import type { IntegrationDeps } from './types';

/** Запасной режим: звонилка телефона и ссылка wa.me. Работает офлайн и без подключений. */
export const FALLBACK_MODES: ChannelModes = {
  telephony: { pluginId: 'telephony.manual', clickToCall: 'tel' },
  messenger: { pluginId: 'messenger.wa_link', chat: 'link' },
};

export async function getChannelModes(viewer: Viewer, deps: IntegrationDeps): Promise<ChannelModes> {
  const spaceId = viewer.spaceId;
  if (!spaceId) return FALLBACK_MODES;
  try {
    const sql = (await getDb()).sql;
    const rows = await listSpaceIntegrations(sql, spaceId);
    if (rows.length === 0) return FALLBACK_MODES;
    const modes: ChannelModes = { telephony: { ...FALLBACK_MODES.telephony }, messenger: { ...FALLBACK_MODES.messenger } };
    let telDone = false;
    let msgDone = false;
    for (const plugin of deps.registry.all()) {
      if (!plugin.needsConnection) continue;
      for (const row of rows.filter((r) => r.pluginId === plugin.id)) {
        if (plugin.kind === 'telephony' && !telDone) {
          if (!(await usabilityOf(deps, plugin, row)).usable) continue;
          modes.telephony = { pluginId: plugin.id, clickToCall: plugin.capabilities.clickToCall };
          telDone = true;
        } else if (plugin.kind === 'messenger' && !msgDone && plugin.capabilities.chat === 'iframe') {
          if (!(await usabilityOf(deps, plugin, row)).usable) continue;
          if (!(await hasEnabledChannel(sql, row.id, spaceId))) continue;
          modes.messenger = { pluginId: plugin.id, chat: 'iframe' };
          msgDone = true;
        }
      }
    }
    return modes;
  } catch (e) {
    // Оболочка рисуется на каждой странице: сбой выбора режима не должен ронять экран — запасной режим работает всегда
    const err = e as { name?: unknown; code?: unknown } | null;
    console.error(JSON.stringify({ level: 'error', code: 'channel_modes_failed', name: String(err?.name ?? ''), pg: String(err?.code ?? '') }));
    return FALLBACK_MODES;
  }
}
