/* Service worker CRM: только оболочка приложения (ARCHITECTURE §7).
 * Что кэшируется: статика сборки (/_next/static, шрифты, иконки) и HTML экранов «Звонить» и «Доска» на случай запуска без сети.
 * Что не кэшируется никогда: любые ответы /api/** и данные карточек — их этот файл не трогает (запрос идёт в сеть),
 * поэтому ПДн на телефоне не копятся. Кэш очищается при выходе (страница сама вызывает caches.delete и ждёт; команда
 * {type:'clear'} — запасной путь), а HTML оболочки ещё и при заходе на /login и при POST /api/auth/*: следующий сотрудник
 * не получит страницу прежнего. Если без сети всё же отдана кэшированная оболочка, в неё вшивается метка
 * <meta name="crm-shell" content="stale">: страница не отправляет итоги, пока не получит себя заново с сервера.
 * Выход не завершён (кэш-метка crm-logout-pending, её ставит страница): оболочка /call не отдаётся из кэша и не
 * кэшируется; в самой оболочке скрипт в <head> по флагу в localStorage прячет страницу (D-063).
 * v3: оболочки v2 (без этого скрипта) удаляются при активации.
 * v4: к оболочке /call добавлена оболочка /board (доска оператора, pipeline-v2 §9.1); правила очистки и метка stale те же.
 * Данные доски (/api/cards/board) не кэшируются: запросы /api/ идут мимо кэша, ПДн на телефоне не копятся. */
const VERSION = 'crm-shell-v4';
const LOGOUT_BLOCK = 'crm-logout-pending';
const SHELL_PATHS = ['/call', '/board'];

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
  return caches.open(VERSION).then((cache) => Promise.all(SHELL_PATHS.map((p) => cache.delete(p))));
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

  // Переход на экран «Звонить» или «Доска»: сеть, а без сети — последняя оболочка этого экрана
  if (req.mode === 'navigate' && SHELL_PATHS.includes(url.pathname)) {
    const shellPath = url.pathname;
    event.respondWith(
      (async () => {
        const cache = await caches.open(VERSION);
        try {
          const res = await fetch(req);
          // Кэшируем только успешную страницу без перенаправления (на вход не уводит) и не во время выхода
          if (res.ok && !res.redirected && !(await caches.has(LOGOUT_BLOCK))) cache.put(shellPath, res.clone());
          return res;
        } catch (e) {
          // Выход не завершён: оболочку прежнего сотрудника из кэша не отдаём
          if (await caches.has(LOGOUT_BLOCK)) throw e;
          const hit = await cache.match(shellPath);
          if (hit) return markStale(hit);
          throw e;
        }
      })(),
    );
  }
});

/* Web-push (P8b, D-328): текст готовит сервер — только вид события и числа, без имён, номеров и названий (D-033).
 * Пока выход не завершён (метка crm-logout-pending), push не показывается. Нажатие открывает только колокол. */
const PUSH_OPEN_PATHS = ['/notifications'];

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      if (await caches.has(LOGOUT_BLOCK)) return;
      let data = {};
      try {
        data = event.data ? event.data.json() : {};
      } catch {
        data = {};
      }
      const title = typeof data.title === 'string' ? data.title.slice(0, 100) : '';
      const body = typeof data.body === 'string' ? data.body.slice(0, 300) : '';
      const tag = typeof data.tag === 'string' && /^[a-z0-9_]{1,40}$/.test(data.tag) ? data.tag : undefined;
      const url = PUSH_OPEN_PATHS.includes(data.url) ? data.url : '/notifications';
      await self.registration.showNotification(title, { body, tag, icon: '/icon/192', data: { url } });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const wanted = event.notification.data && PUSH_OPEN_PATHS.includes(event.notification.data.url) ? event.notification.data.url : '/notifications';
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const w of wins) {
        if (new URL(w.url).origin === self.location.origin && 'focus' in w) {
          if ('navigate' in w) await w.navigate(wanted).catch(() => undefined);
          return w.focus();
        }
      }
      return self.clients.openWindow(wanted);
    })(),
  );
});
