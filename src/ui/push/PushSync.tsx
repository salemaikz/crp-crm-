'use client';
// Привязка подписки push к текущей сессии после входа (D-328): на каждой загрузке оболочки сервер говорит, привязана
// ли подписка этого браузера к текущей сессии. Сотрудник сменился — проверка повторяется. Ничего не рисует.
import { useEffect } from 'react';
import { syncPush } from './device';

export function PushSync({ userId }: { userId: string }) {
  useEffect(() => {
    void syncPush();
  }, [userId]);
  return null;
}
