// GET — CSV строк по фильтру для Excel (BOM, «;», формулы обезврежены). Имя файла без данных клиентов.
import { getTranslations } from 'next-intl/server';
import { route } from '@/server/access';
import { DEFAULT_HEADERS, importService } from '@/server/domain/import';
import { actorOf, guarded, idOf, queryOf, RowsQuery } from '../../_lib';

async function headers(): Promise<readonly string[]> {
  try {
    const t = await getTranslations('import.export');
    return DEFAULT_HEADERS.map((h) => t(h));
  } catch {
    return DEFAULT_HEADERS;
  }
}

export const GET = route({ perm: 'import.run' }, ({ req, params, viewer }) =>
  guarded(async () => {
    const q = RowsQuery.parse(queryOf(req));
    const { csv } = await importService.exportRowsCsv(actorOf(viewer), idOf(params), q.filter, Date.now(), await headers());
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="import-rows.csv"',
        'Cache-Control': 'no-store',
      },
    });
  }),
);
