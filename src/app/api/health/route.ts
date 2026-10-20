import pkg from '../../../../package.json';

// Проверка живости для nginx и healthcheck.sh: без данных и без обращения к БД, только ok и версия.
// Это единственный маршрут вне обёртки route() (docs/ARCHITECTURE.md §5.2): данных в ответе нет.
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ status: 'ok', version: pkg.version }, { headers: { 'Cache-Control': 'no-store' } });
}
