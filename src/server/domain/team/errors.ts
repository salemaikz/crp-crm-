// Ошибки модуля: код доступа (для обёрток) + машинный detail, по которому интерфейс выбирает текст.
import { AccessError, type AccessErrorCode } from '@/server/access/errors';

export class TeamError extends AccessError {
  constructor(
    code: AccessErrorCode,
    readonly detail: string,
  ) {
    super(code, `${code}:${detail}`);
  }
}

export const conflict = (detail: string) => new TeamError('conflict', detail);
export const badRequest = (detail: string) => new TeamError('bad_request', detail);
