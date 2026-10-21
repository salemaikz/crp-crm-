// POST — массовая передача карточек сотрудника одному или поровну (B9a, FEATURE_BULK_TRANSFER). Повтор opId безопасен.
import { route } from '@/server/access';
import { TransferBulkInput, transferBulk } from '@/server/domain/team';
import { readBody } from '../../_lib';

export const POST = route({ perm: 'client.transfer' }, async ({ req, viewer }) => {
  const input = await readBody(req, TransferBulkInput);
  return transferBulk(viewer, input);
});
