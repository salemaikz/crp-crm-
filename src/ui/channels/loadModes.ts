// Режимы каналов для серверных компонентов (оболочка, карточка клиента): реестр плагинов → домен интеграций.
import type { ChannelModes } from '@/integrations/contract';
import { pluginDeps } from '@/integrations/registry';
import type { Viewer } from '@/server/access';
import { getChannelModes } from '@/server/domain/integrations';

export function loadChannelModes(viewer: Viewer): Promise<ChannelModes> {
  return getChannelModes(viewer, pluginDeps());
}
