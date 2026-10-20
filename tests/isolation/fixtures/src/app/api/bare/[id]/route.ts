// ПЛОХОЙ: без обёртки (ловится статическим тестом обёрток, а не прогоном).
export async function GET() {
  return Response.json({ secret: 1 });
}
