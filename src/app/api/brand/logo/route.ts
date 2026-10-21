import { publicRoute } from '@/server/access';
import { logoResponse } from '@/server/platform/brand';

// Логотип клиента для шапки и входа (D-333). Публичный: нужен до входа. Файл берётся только из настроек
// (theme.logo) и каталога ассетов; параметры запроса и params на выбор файла не влияют.
export const dynamic = 'force-dynamic';

export const GET = publicRoute({ reason: 'asset', origin: 'check' }, async ({ req }) => logoResponse(req));
