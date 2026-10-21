// Адрес подписки приходит от браузера, а запрос по нему делает сервер. Поэтому принимаются только адреса push-сервисов
// браузеров из закрытого списка (D-329, INTEGRATIONS §8): https, порт по умолчанию, без учётки в адресе. Иначе
// подписка стала бы способом заставить сервер ходить на произвольный адрес, в том числе во внутреннюю сеть.

/** Хосты целиком: FCM (Chrome, Edge на Android, Samsung), Apple (Safari, PWA на iOS 16.4+), Mozilla. */
export const PUSH_HOSTS: readonly string[] = ['fcm.googleapis.com', 'web.push.apple.com', 'updates.push.services.mozilla.com'];
/** Хосты по суффиксу: Windows Push Notification Services (Edge на Windows). */
export const PUSH_HOST_SUFFIXES: readonly string[] = ['.notify.windows.com'];

export const PUSH_ENDPOINT_MAX = 1024;

/** Разобранный адрес подписки или null, если он не из списка. */
export function checkPushEndpoint(raw: string): URL | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > PUSH_ENDPOINT_MAX) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.port !== '' || u.username !== '' || u.password !== '' || u.hash !== '') return null;
  const host = u.hostname.toLowerCase();
  const ok = PUSH_HOSTS.includes(host) || PUSH_HOST_SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length && /^[a-z0-9.-]+$/.test(host));
  return ok ? u : null;
}
