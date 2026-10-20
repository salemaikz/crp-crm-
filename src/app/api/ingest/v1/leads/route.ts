import { publicRoute } from '@/server/access';
import { handleLeads } from '@/server/domain/intake';

// Приём партии лидов по ключу (INTEGRATIONS §5.2): сессии нет, Origin не проверяется (машинный вход с ключом).
// Ключ, лимиты, закрытие снаружи и ошибки в формате ingest/v1 — в handleLeads.
export const dynamic = 'force-dynamic';

export const POST = publicRoute({ reason: 'ingest', origin: 'skip' }, ({ req }) => handleLeads(req));
