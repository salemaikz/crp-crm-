// Предложенные операторами контакты на разборе РОП (D-258): номер и название целиком, совпавший клиент — в охвате чтения.
import { route } from '@/server/access';
import { listProposals } from '@/server/domain/distribution';
import { respond } from '../_lib';

export const GET = route({ perm: 'pool.read' }, ({ viewer }) => respond(async () => ({ items: await listProposals(viewer) })));
