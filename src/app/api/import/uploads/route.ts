// POST — загрузка файла сырым телом (D-112): не multipart, потому что Next читает его без предела.
// ?profile=<ключ>&sheet=<имя|номер>&snapshotDay=YYYY-MM-DD, имя файла — заголовок X-File-Name.
import { route } from '@/server/access';
import { importService, uploadLimitBytes } from '@/server/domain/import';
import { rateLimit } from '@/server/platform/ratelimit';
import { SpreadsheetError, readBodyLimited } from '@/server/platform/files';
import { actorOf, guarded, queryOf, UploadQuery } from '../_lib';

const WINDOW_MS = 10 * 60_000;
const LIMIT = 20;

function fileName(req: Request): string {
  const raw = req.headers.get('x-file-name') ?? '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return '';
  }
}

export const POST = route({ perm: 'import.run' }, ({ req, viewer }) =>
  guarded(async () => {
    const actor = actorOf(viewer);
    const q = UploadQuery.parse(queryOf(req));
    if ((req.headers.get('content-type') ?? '').toLowerCase().startsWith('multipart/')) throw new SpreadsheetError('bad_type');
    const rl = rateLimit(`import-upload:${viewer.userId}`, LIMIT, WINDOW_MS);
    if (!rl.ok) {
      return Response.json({ error: 'rate_limited' }, { status: 429, headers: { 'Cache-Control': 'no-store', 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) } });
    }
    const body = await readBodyLimited(req, await uploadLimitBytes(actor));
    const result = await importService.upload(
      actor,
      { profileKey: q.profile, snapshotDay: q.snapshotDay, fileName: fileName(req), body, ...(q.sheet !== undefined ? { sheet: q.sheet } : {}) },
      Date.now(),
    );
    return Response.json(result, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  }),
);
