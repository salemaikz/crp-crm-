import { route } from '@/server/access';
import { getClientSummaryFor } from '@/server/domain/clients';
import { pathId } from '../../_support';

// Итоговый отчёт по клиенту: структура без текста (фразу строит интерфейс).
export const GET = route({ perm: 'client.read', target: 'object' }, async ({ params, viewer }) => getClientSummaryFor(viewer, pathId(params)));
