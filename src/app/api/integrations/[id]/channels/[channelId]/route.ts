import { pluginDeps } from '@/integrations/registry';
import { route } from '@/server/access';
import { patchIntegrationChannel } from '@/server/domain/integrations';
import { ChannelBody, idParam, readJson, respond } from '../../../_lib';

// Привязка канала к оператору (или общий, ownerUserId = null) и включение канала.
export const PATCH = route({ perm: 'admin' }, ({ req, params, viewer }) =>
  respond(async () => {
    const body = await readJson(req, ChannelBody);
    return patchIntegrationChannel(viewer, pluginDeps(), { integrationId: idParam(params.id), channelId: idParam(params.channelId), ...body });
  }),
);
