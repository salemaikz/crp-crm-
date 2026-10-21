// GET — предпросмотр массовой передачи: счётчики по состояниям, семьи, задачи, сделки, записи (FEATURE_BULK_TRANSFER).
import { route } from '@/server/access';
import { TransferPreviewQuery, previewBulk } from '@/server/domain/team';

export const GET = route({ perm: 'client.transfer' }, async ({ req, viewer }) => {
  const q = Object.fromEntries(new URL(req.url).searchParams);
  return previewBulk(viewer, TransferPreviewQuery.parse(q));
});
