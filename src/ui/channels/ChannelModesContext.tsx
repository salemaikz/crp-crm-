'use client';

// Режимы каналов на клиенте (D-268, дизайн §7.3): сервер решает «как звонить и писать», оболочка кладёт ответ сюда.
// Без провайдера (офлайн-страница, тесты) — запасной режим: звонилка телефона и ссылка wa.me.
import { createContext, useContext, type ReactNode } from 'react';
import type { ChannelModes } from '@/integrations/contract';

export const DEFAULT_CHANNEL_MODES: ChannelModes = {
  telephony: { pluginId: 'telephony.manual', clickToCall: 'tel' },
  messenger: { pluginId: 'messenger.wa_link', chat: 'link' },
};

const ChannelModesContext = createContext<ChannelModes>(DEFAULT_CHANNEL_MODES);

export function ChannelModesProvider({ modes, children }: { modes: ChannelModes; children: ReactNode }) {
  return <ChannelModesContext.Provider value={modes}>{children}</ChannelModesContext.Provider>;
}

export function useChannelModes(): ChannelModes {
  return useContext(ChannelModesContext);
}
