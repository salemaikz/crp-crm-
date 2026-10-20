// Общее для маршрутов выгрузок (R3b): коды 429 и 413 без текста, ответы без кэша. Остальные ошибки — на обёртку route().
import { ExportLimitError, ExportTooLargeError } from '@/server/domain/reports';
import { XlsxWriteError } from '@/server/platform/files';

const NO_STORE = { 'Cache-Control': 'no-store' };

/** Выполнить сервис выгрузки; лимиты → 429 `rate_limited` с причиной, большая книга → 413 `too_many_rows`. */
export async function exportGuard(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ExportLimitError) {
      const headers: Record<string, string> = { ...NO_STORE };
      if (e.retryAfterSec !== null) headers['Retry-After'] = String(e.retryAfterSec);
      return Response.json({ error: 'rate_limited', detail: e.code }, { status: 429, headers });
    }
    if (e instanceof ExportTooLargeError || e instanceof XlsxWriteError) {
      return Response.json({ error: 'too_large', detail: 'too_many_rows' }, { status: 413, headers: NO_STORE });
    }
    throw e;
  }
}

/** Заголовки файла: только ASCII-имя, без кэша и угадывания типа. */
export function fileHeaders(contentType: string, filename: string): Record<string, string> {
  return {
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
}
