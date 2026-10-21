// Тела и параметры запросов экрана задач (Zod `.strict()`): лишние поля — 400, тексты — по длине.
import { z } from 'zod';
import { BadRequestError } from '@/server/access';
import { TASK_VIEWS, type ListTasksQuery, type TaskView } from './types';

const uuid = z.string().uuid();
const id = z.string().min(1).max(100);
const due = z.number().int().nonnegative().nullable();
const MANUAL_KINDS = ['call', 'message', 'meeting', 'check', 'other'] as const;

export const createTaskBody = z
  .object({
    opId: uuid,
    clientId: id,
    dealId: id.nullable().optional(),
    kind: z.enum(MANUAL_KINDS),
    title: z.string().min(1).max(400),
    dueAt: due,
    assigneeUserId: id,
  })
  .strict();

export const updateTaskBody = z
  .object({ title: z.string().min(1).max(400).optional(), dueAt: due.optional(), assigneeUserId: id.optional() })
  .strict();

export const completeTaskBody = z.object({ comment: z.string().max(4000).optional() }).strict();

export const commentBody = z.object({ opId: uuid, body: z.string().min(1).max(4000) }).strict();

/** `?view=mine|team|unassigned|done&userId=&clientId=`; неизвестное значение — 400. */
export function parseListTasksQuery(sp: URLSearchParams): ListTasksQuery {
  const view = sp.get('view') ?? 'mine';
  if (!(TASK_VIEWS as readonly string[]).includes(view)) throw new BadRequestError('view');
  const userId = sp.get('userId');
  const clientId = sp.get('clientId');
  for (const v of [userId, clientId]) if (v !== null && (v.length === 0 || v.length > 100)) throw new BadRequestError('id');
  return { view: view as TaskView, userId, clientId };
}
