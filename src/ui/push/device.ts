// Push на устройстве (P8b, D-328): включить, сверить привязку к сессии после входа, снять при выходе.
// Сервер шлёт push, только пока жива сессия, которая подписала устройство; поэтому после каждого входа подписка
// заново привязывается к новой сессии (syncPush), а при выходе снимается в браузере первым делом — без сети тоже.
// Кнопку «Уведомления на телефон» (жест пользователя для запроса разрешения) рисует экран профиля (P8b-2).
import { createDeviceStore } from '../call/outboxStore';
import { ensureDeviceId } from '../call/device';

type PushStatus = { available: boolean; publicKey: string | null };

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;
  return (await navigator.serviceWorker.getRegistration('/')) ?? null;
}

function keyBytes(b64u: string): Uint8Array {
  const s = b64u.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

async function status(): Promise<PushStatus | null> {
  try {
    const res = await fetch('/api/push', { cache: 'no-store', credentials: 'same-origin' });
    return res.ok ? ((await res.json()) as PushStatus) : null;
  } catch {
    return null;
  }
}

async function deviceId(): Promise<string> {
  try {
    return await ensureDeviceId(createDeviceStore().store);
  } catch {
    return '';
  }
}

async function postSubscription(sub: PushSubscription): Promise<boolean> {
  const j = sub.toJSON();
  const body = { endpoint: sub.endpoint, p256dh: j.keys?.p256dh ?? '', auth: j.keys?.auth ?? '', deviceId: await deviceId() };
  try {
    const res = await fetch('/api/push/subscribe', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Подписка браузера на ключ сервера: прежняя на другой ключ (ключи сменили) снимается и создаётся заново. */
async function browserSubscription(reg: ServiceWorkerRegistration, publicKey: string, create: boolean): Promise<PushSubscription | null> {
  const key = keyBytes(publicKey);
  const current = await reg.pushManager.getSubscription();
  if (current && sameKey(current.options.applicationServerKey, key)) return current;
  if (current) await current.unsubscribe().catch(() => false);
  if (!create) return null;
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource });
}

export type EnableResult = 'on' | 'denied' | 'unavailable' | 'error';

/** Включить push на этом устройстве. Вызывать только из обработчика нажатия (iOS требует жест). */
export async function enablePush(): Promise<EnableResult> {
  const reg = await registration();
  if (!reg) return 'unavailable';
  const st = await status();
  if (!st?.available || !st.publicKey) return 'unavailable';
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return 'denied';
  try {
    const sub = await browserSubscription(reg, st.publicKey, true);
    return sub && (await postSubscription(sub)) ? 'on' : 'error';
  } catch {
    return 'error';
  }
}

/** Выключить push на этом устройстве (кнопка в профиле): подписка снимается и в браузере, и на сервере. */
export async function disablePush(): Promise<void> {
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription().catch(() => null);
  const endpoint = sub?.endpoint ?? null;
  await sub?.unsubscribe().catch(() => false);
  await fetch('/api/push/unsubscribe', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  }).catch(() => undefined);
}

const SYNC_KEY = 'crm-push-sync';

/**
 * После входа: разрешение уже дано и подписка есть — привязать её к текущей сессии (раз на сессию вкладки и
 * сотрудника). Push недоступен — ничего не делаем. Не бросает.
 */
export async function syncPush(userId: string): Promise<void> {
  try {
    if (!pushSupported() || Notification.permission !== 'granted') return;
    if (window.sessionStorage.getItem(SYNC_KEY) === userId) return;
    const reg = await registration();
    if (!reg || !(await reg.pushManager.getSubscription())) return;
    const st = await status();
    if (!st?.available || !st.publicKey) return;
    const sub = await browserSubscription(reg, st.publicKey, true);
    if (sub && (await postSubscription(sub))) window.sessionStorage.setItem(SYNC_KEY, userId);
  } catch {
    // push — не основной канал: колокол работает всегда
  }
}

/**
 * Выход (D-063, D-310): подписка снимается в браузере первым делом и без сети — следующий человек на этом телефоне
 * push прежнего не получит. Сервер и так не шлёт: сессия, подписавшая устройство, закрыта. Не бросает.
 */
export async function dropDevicePush(): Promise<void> {
  try {
    window.sessionStorage.removeItem(SYNC_KEY);
    const reg = await registration();
    const sub = await reg?.pushManager.getSubscription();
    await sub?.unsubscribe();
  } catch {
    // нет поддержки или подписки — снимать нечего
  }
}
