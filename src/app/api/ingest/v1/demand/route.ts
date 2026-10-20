import { publicRoute } from '@/server/access';
import { handleDemand } from '@/server/domain/intake';

// Потребность в новых карточках (INTEGRATIONS §5.3): только числа, по ключу с разрешением leads:demand.
export const dynamic = 'force-dynamic';

export const GET = publicRoute({ reason: 'ingest', origin: 'skip' }, ({ req }) => handleDemand(req));
