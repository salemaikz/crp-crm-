// Push на устройстве (P8b, D-328): включить, сверить привязку к сессии после входа, снять при выходе.
// Сервер шлёт push, только пока жива сессия, которая подписала устройство; поэтому после каждого входа подписка
// заново привязывается к новой сессии (syncPush), а при выходе снимается в браузере первым делом — без сети тоже.
// Привязан ли браузер к текущей сессии, знает только сервер (`bound`): «выйти везде», простой и сброс пароля меняют
// сессию без обычного выхода, поэтому признак в хранилище вкладки здесь не годится.
// Кнопку «Уведомления на телефон» (жест пользователя для запроса разрешения) рисует экран профиля (P8b-2).
import { createDeviceStore } from '../call/outboxStore';
import { ensureDeviceId } from '../call/device';

type PushStatus = { available: boolean; publicKey: string | null; bound: boolean };

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

/** Отписка на сервере: подписки этой сессии и своя с этим адресом. `keepalive` — запрос переживёт уход со страницы. */
function postUnsubscribe(endpoint: string | null, keepalive: boolean): Promise<unknown> {
  return fetch('/api/push/unsubscribe', {
    method: 'POST',
    credentials: 'same-origin',
    keepalive,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  }).catch(() => undefined);
}

/** Выключить push на этом устройстве (кнопка в профиле): подписка снимается и в браузере, и на сервере. */
export async function disablePush(): Promise<void> {
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription().catch(() => null);
  const endpoint = sub?.endpoint ?? null;
  await sub?.unsubscribe().catch(() => false);
  await postUnsubscribe(endpoint, false);
}

/**
 * Подписка браузера есть, а сервер не видит её за текущей сессией (`bound` ложно) или ключ сервера сменился —
 * привязать заново. true — подписка привязана к этой сессии.
 */
async function bind(reg: ServiceWorkerRegistration, st: PushStatus): Promise<boolean> {
  const current = await reg.pushManager.getSubscription();
  if (!current || !st.publicKey) return false;
  const sub = await browserSubscription(reg, st.publicKey, true);
  if (!sub) return false;
  if (st.bound && sub === current) return true;
  return postSubscription(sub);
}

// Одна привязка за раз: оболочка (syncPush) и экран профиля (pushInfo) спрашивают одновременно
let binding: Promise<boolean> | null = null;

function ensureBound(reg: ServiceWorkerRegistration, st: PushStatus): Promise<boolean> {
  binding ??= bind(reg, st).finally(() => {
    binding = null;
  });
  return binding;
}

/**
 * После входа (на каждой загрузке оболочки): разрешение дано и подписка в браузере есть — убедиться, что сервер
 * держит её за текущей сессией, иначе привязать. Push недоступен — ничего не делаем. Не бросает.
 */
export async function syncPush(): Promise<void> {
  try {
    if (!pushSupported() || Notification.permission !== 'granted') return;
    const reg = await registration();
    if (!reg || !(await reg.pushManager.getSubscription())) return;
    const st = await status();
    if (!st?.available) return;
    await ensureBound(reg, st);
  } catch {
    // push — не основной канал: колокол работает всегда
  }
}

/**
 * Выход (D-063, D-310): подписка снимается в браузере первым делом и без сети — следующий человек на этом телефоне
 * push прежнего не получит. Затем отписка на сервере без ожидания ответа: сервер и так не шлёт после закрытия
 * сессии, а так строка выключается сразу. Не бросает.
 */
export async function dropDevicePush(): Promise<void> {
  let endpoint: string | null = null;
  try {
    const reg = await registration();
    const sub = await reg?.pushManager.getSubscription();
    endpoint = sub?.endpoint ?? null;
    await sub?.unsubscribe();
  } catch {
    // нет поддержки или подписки — снимать нечего
  }
  if (endpoint !== null) void postUnsubscribe(endpoint, true);
}

export type PushInfo =
  | { kind: 'hidden' }
  | { kind: 'unsupported'; ios: boolean }
  | { kind: 'denied' }
  | { kind: 'off' }
  | { kind: 'on' };

/** iPhone и iPad (в том числе iPadOS, который назвался Mac): push там — только из установленного приложения. */
function isIos(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/**
 * Что показать в профиле. Push выключен на сервере (флаг, ключи, переключатель, лицензия, роль «только чтение») —
 * кнопки нет вовсе. «Включены» — только когда подписка браузера привязана к текущей сессии. Не бросает.
 */
export async function pushInfo(): Promise<PushInfo> {
  try {
    const st = await status();
    if (!st?.available) return { kind: 'hidden' };
    if (!pushSupported()) return { kind: 'unsupported', ios: isIos() };
    if (Notification.permission === 'denied') return { kind: 'denied' };
    if (Notification.permission !== 'granted') return { kind: 'off' };
    const reg = await registration();
    return reg && (await ensureBound(reg, st)) ? { kind: 'on' } : { kind: 'off' };
  } catch {
    return { kind: 'hidden' };
  }
}
