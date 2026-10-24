'use client';
// Привязка подписки push к текущей сессии после входа (D-328): на каждой загрузке оболочки сервер говорит, привязана
// ли подписка этого браузера к текущей сессии. Сотрудник сменился — проверка повторяется. Ничего не рисует.
// Service worker регистрируется здесь же, в оболочке любой роли: push и «Мой аккаунт» не должны зависеть от того, заходил ли
// человек на «Звонить» или «Доску» и успели ли те загрузить данные (на /account иначе `serviceWorker.ready` не наступает).
import { useEffect } from 'react';
import { registerShell } from '../call/serviceWorker';
import { syncPush } from './device';

export function PushSync({ userId }: { userId: string }) {
  useEffect(() => {
    void registerShell().then(syncPush);
  }, [userId]);
  return null;
}
