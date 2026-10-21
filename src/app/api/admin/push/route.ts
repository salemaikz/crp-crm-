// Web-push установки (D-328): состояние для экрана администратора; отметка письменного решения клиента и переключатель.
import { route } from '@/server/access';
import { pushAdminState, setPushSettings } from '@/server/domain/notify';
import { PushSettingsBody, readJson } from '../../push/_lib';

export const GET = route({ perm: 'admin' }, async ({ viewer }) => pushAdminState(viewer));

export const POST = route({ perm: 'admin' }, async ({ req, viewer }) => setPushSettings(viewer, await readJson(req, PushSettingsBody)));
