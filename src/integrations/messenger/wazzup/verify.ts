// Подлинность вебхука Wazzup (INTEGRATIONS §3.2): подписи у провайдера нет, поэтому проверка складывается из
// токена в пути (общий маршрут сверил хэш), принадлежности канала подключению (apply) и лимитов (маршрут).
// Здесь — только форма запроса и служебный тест при подписке. Сверка `crmKey` добавляется, когда песочница
// подтвердит, что провайдер позволяет его задать.
import type { RawRequest, VerifyResult } from '../../contract';

export function verifyWazzup(req: RawRequest): VerifyResult {
  const body = req.json;
  if (req.method !== 'POST' || typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, code: 'bad_body' };
  if ((body as { test?: unknown }).test === true) return { ok: true, test: true };
  return { ok: true, test: false };
}
