import { z } from 'zod';
import { route } from '@/server/access';
import { proposeContact } from '@/server/domain/intake';
import { readJson } from '../_support';
import { parseBody } from '@/server/domain/clients';

const ProposeBody = z.object({ opId: z.string().uuid(), phone: z.string().min(1).max(60), name: z.string().min(1).max(200) }).strict();

// «Предложить контакт» (D-258): ответ всегда 202 `{status:'accepted'}` — и для чужого номера, и для свободного, и на повтор.
export const POST = route({ perm: 'client.propose', target: 'section' }, async ({ req, viewer }) => {
  const body = parseBody(ProposeBody, await readJson(req));
  const result = await proposeContact(viewer, body);
  return Response.json(result, { status: 202, headers: { 'Cache-Control': 'no-store' } });
});
