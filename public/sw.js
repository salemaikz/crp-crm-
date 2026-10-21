/* Service worker CRM: только оболочка приложения (ARCHITECTURE §7).
 * Что кэшируется: статика сборки (/_next/static, шрифты, иконки) и HTML экрана «Звонить» на случай запуска без сети.
 * Что не кэшируется никогда: любые ответы /api/** и данные карточек — их этот файл не трогает (запрос идёт в сеть),
 * поэтому ПДн на телефоне не копятся. Кэш очищается при выходе (страница сама вызывает caches.delete и ждёт; команда
 * {type:'clear'} — запасной путь), а HTML оболочки ещё и при заходе на /login и при POST /api/auth/*: следующий сотрудник
 * не получит страницу прежнего. Если без сети всё же отдана кэшированная оболочка, в неё вшивается метка
 * <meta name="crm-shell" content="stale">: страница не отправляет итоги, пока не получит себя заново с сервера.
 * Выход не завершён (кэш-метка crm-logout-pending, её ставит страница): оболочка /call не отдаётся из кэша и не
 * кэшируется; в самой оболочке скрипт в <head> по флагу в localStorage прячет страницу (D-063).
 * v3: оболочки v2 (без этого скрипта) удаляются при активации. */
const VERSION = 'crm-shell-v3';
const LOGOUT_BLOCK = 'crm-logout-pending';
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

// HTML оболочки (но не статика сборки) удаляется: смена сотрудника на устройстве
function dropShellHtml() {
  return caches.open(VERSION).then((cache) => cache.delete(SHELL_PATH));
}

// Кэшированная оболочка с меткой «из кэша» (страница по ней понимает, что сессия не проверена)
async function markStale(hit) {
  const html = await hit.text();
  const meta = '<meta name="crm-shell" content="stale">';
  const marked = /<head[^>]*>/.test(html) ? html.replace(/<head[^>]*>/, (m) => m + meta) : meta + html;
  const headers = new Headers(hit.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  return new Response(marked, { status: hit.status, statusText: hit.statusText, headers });
}

function isStatic(url) {
  return url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/fonts/') || url.pathname.startsWith('/icon/');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Вход и выход: оболочка прежнего сотрудника удаляется (запрос идёт в сеть как обычно)
  if (req.method === 'POST' && url.pathname.startsWith('/api/auth/')) {
    event.waitUntil(dropShellHtml());
    return;
  }
  if (req.method !== 'GET') return;
  if (req.mode === 'navigate' && url.pathname.startsWith('/login')) {
    event.waitUntil(dropShellHtml());
    return;
  }
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
          // Кэшируем только успешную страницу без перенаправления (на вход не уводит) и не во время выхода
          if (res.ok && !res.redirected && !(await caches.has(LOGOUT_BLOCK))) cache.put(SHELL_PATH, res.clone());
          return res;
        } catch (e) {
          // Выход не завершён: оболочку прежнего сотрудника из кэша не отдаём
          if (await caches.has(LOGOUT_BLOCK)) throw e;
          const hit = await cache.match(SHELL_PATH);
          if (hit) return markStale(hit);
          throw e;
        }
      })(),
    );
  }
});
