/* Service worker CRM: только оболочка приложения (ARCHITECTURE §7).
 * Что кэшируется: статика сборки (/_next/static, шрифты, иконки) и HTML экрана «Звонить» на случай запуска без сети.
 * Что не кэшируется никогда: любые ответы /api/** и данные карточек — их этот файл не трогает (запрос идёт в сеть),
 * поэтому ПДн на телефоне не копятся. Кэш очищается командой {type:'clear'} при выходе из приложения. */
const VERSION = 'crm-shell-v1';
const SHELL_PATH = '/call';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('crm-shell-') && k !== VERSION).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'clear') {
    event.waitUntil(caches.delete(VERSION));
  }
});

function isStatic(url) {
  return url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/fonts/') || url.pathname.startsWith('/icon/');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // API и всё прочее динамическое — мимо кэша
  if (url.pathname.startsWith('/api/')) return;

  if (isStatic(url)) {
    event.respondWith(
      caches.open(VERSION).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  // Переход на экран «Звонить»: сеть, а без сети — последняя оболочка
  if (req.mode === 'navigate' && url.pathname === SHELL_PATH) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(VERSION);
        try {
          const res = await fetch(req);
          // Кэшируем только успешную страницу без перенаправления (на вход не уводит)
          if (res.ok && !res.redirected) cache.put(SHELL_PATH, res.clone());
          return res;
        } catch (e) {
          const hit = await cache.match(SHELL_PATH);
          if (hit) return hit;
          throw e;
        }
      })(),
    );
  }
});
