// Пользователь страницы → ImportActor (охват импорта — пространство). Нет пространства — раздела нет (404).
import { NotFoundError, type Viewer } from '@/server/access';
import type { ImportActor } from '@/server/domain/import';

export function actorOf(viewer: Viewer): ImportActor {
  if (viewer.spaceId === null) throw new NotFoundError();
  return { userId: viewer.userId, spaceId: viewer.spaceId };
}
