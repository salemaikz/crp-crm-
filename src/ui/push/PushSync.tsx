'use client';
// Привязка подписки push к текущей сессии после входа (D-328). Ничего не рисует.
import { useEffect } from 'react';
import { syncPush } from './device';

export function PushSync({ userId }: { userId: string }) {
  useEffect(() => {
    void syncPush(userId);
  }, [userId]);
  return null;
}
