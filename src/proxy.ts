// Первый рубеж CSRF (D-095): любой мутирующий запрос без верного Origin получает 403 ещё до
// маршрута. Закрывает и server actions (POST на путь страницы), и route handlers; Next сам пропускает
// server action без Origin. Второй рубеж — те же проверки в обёртках маршрутов.
import { NextResponse, type NextRequest } from 'next/server';
import { checkOrigin, originCheckRequired } from '@/server/platform/auth/csrf';

export function proxy(request: NextRequest): NextResponse {
  if (originCheckRequired(request.method, request.nextUrl.pathname) && checkOrigin(request.headers) !== 'ok') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }
  const res = NextResponse.next();
  // Страница приглашения: токен во фрагменте не уходит на сервер, но страница не должна ни кэшироваться,
  // ни отдавать Referer (D-094); next.config.ts — не зона P3, поэтому заголовки ставит proxy.
  const path = request.nextUrl.pathname;
  if (path === '/invite' || path.startsWith('/invite/')) {
    res.headers.set('Referrer-Policy', 'no-referrer');
    res.headers.set('Cache-Control', 'no-store');
  }
  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png|manifest.webmanifest).*)'],
};
