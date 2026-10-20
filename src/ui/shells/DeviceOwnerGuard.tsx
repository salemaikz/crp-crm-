'use client';

// Смена сотрудника на общем телефоне без выхода (D-291): при загрузке любой страницы оболочки данные экрана
// «Звонить» других сотрудников удаляются или обезличиваются (src/ui/call/deviceOwner.ts). Ничего не рисует.
import { useEffect } from 'react';
import { sanitizeForeign } from '@/ui/call/deviceOwner';
import { browserStorage } from '@/ui/call/logoutPending';
import { createDeviceStore } from '@/ui/call/outboxStore';

export function DeviceOwnerGuard({ userId }: { userId: string }) {
  useEffect(() => {
    void sanitizeForeign(userId, { storage: browserStorage(), store: typeof indexedDB === 'undefined' ? null : createDeviceStore().store });
  }, [userId]);
  return null;
}
