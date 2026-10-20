// Формы данных экрана «Интеграции» (клиентский код не импортирует src/server): совпадают с ответом
// GET /api/integrations; совместимость с доменом проверяет присваивание в page.tsx.
export type Usability = { usable: true } | { usable: false; reason: 'flag_off' | 'not_licensed' | 'disabled' | 'crossborder_not_approved' };

export type ChannelView = {
  id: string;
  integrationId: string;
  spaceId: string;
  providerChannelId: string;
  transport: string;
  plainId: string | null;
  state: string;
  stateChangedAt: number | null;
  ownerUserId: string | null;
  isEnabled: boolean;
};

export type ConnectionView = {
  id: string;
  enabled: boolean;
  status: string;
  lastEventAt: number | null;
  crossborderApprovedAt: number | null;
  secrets: { name: string; last4: string }[];
  channels: ChannelView[];
  usability: Usability;
};

export type PluginView = {
  pluginId: string;
  kind: string;
  flagOn: boolean;
  licensed: boolean;
  crossBorder: boolean;
  needsConnection: boolean;
  usability: Usability;
  connection: ConnectionView | null;
};

export type Owner = { id: string; name: string };
