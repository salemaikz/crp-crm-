// Переход документа на адрес API (D-310). API вызывает только fetch страницы приложения; открыть адрес API в адресной
// строке, закладкой, из истории или через view-source может лишь человек, и JSON с данными в этом случае скрипт
// блокировки не прячет. Поэтому route() отвечает на такой GET 404 без данных, до чтения сессии. Исключение —
// скачивание файлов: ссылка `download` браузера — это тоже переход документа. Список ниже закрытый; тест сверяет его
// с файлами маршрутов (каждый — GET, отдающий файл с Content-Disposition).

/** Маршруты скачивания (шаблон пути App Router, `[id]` — один сегмент). Новый — только с тестом и ревью. */
export const DOWNLOAD_ROUTES: readonly string[] = Object.freeze(['/api/import/[id]/rows.csv', '/api/reports/[key]/export']);

/** Назначения запроса, при которых ответ показывается как документ. */
const DOCUMENT_DESTS = new Set(['document', 'iframe', 'frame', 'embed', 'object']);

/**
 * Запрос — переход документа (адресная строка, ссылка, фрейм), а не fetch. По заголовкам Fetch Metadata; браузер без
 * них (старый Safari до 16.4) сюда не попадает — для него остаётся метка выхода и простой сессии (D-310).
 */
export function isDocumentNavigation(headers: Headers): boolean {
  const mode = headers.get('sec-fetch-mode');
  if (mode === 'navigate' || mode === 'nested-navigate') return true;
  const dest = headers.get('sec-fetch-dest');
  return dest !== null && DOCUMENT_DESTS.has(dest);
}

function matches(pattern: string, path: string): boolean {
  const p = pattern.split('/');
  const a = path.split('/');
  if (p.length !== a.length) return false;
  return p.every((seg, i) => (seg.startsWith('[') && seg.endsWith(']') ? (a[i] ?? '') !== '' : seg === a[i]));
}

/** Путь — маршрут скачивания из закрытого списка. */
export function isDownloadRoute(pathname: string): boolean {
  return DOWNLOAD_ROUTES.some((p) => matches(p, pathname));
}

/** GET/HEAD переходом документа на маршрут, который не скачивание: ответить 404 без данных. */
export function refuseDocumentNavigation(req: Request): boolean {
  const method = req.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (!isDocumentNavigation(req.headers)) return false;
  let pathname: string;
  try {
    pathname = new URL(req.url).pathname;
  } catch {
    return true;
  }
  return !isDownloadRoute(pathname);
}
