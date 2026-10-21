// Ошибки слияния и разбора пар: код доступа (для обёрток) + машинный detail, по которому интерфейс выбирает текст.
// Без ПДн: только коды.
import { AccessError, type AccessErrorCode } from '@/server/access/errors';

export type MergeErrorDetail =
  | 'changed'
  | 'booking_conflict'
  | 'other_space'
  | 'not_open'
  | 'op_id'
  | 'comment_required';

export class MergeError extends AccessError {
  constructor(
    code: AccessErrorCode,
    readonly detail: MergeErrorDetail,
  ) {
    super(code, `${code}:${detail}`);
  }
}

export const mergeConflict = (detail: MergeErrorDetail) => new MergeError('conflict', detail);
export const mergeBadRequest = (detail: MergeErrorDetail) => new MergeError('bad_request', detail);
