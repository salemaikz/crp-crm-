// Viewer текущего запроса для обёрток. По умолчанию — buildViewer() (БД на каждом запросе);
// тесты обёрток могут подставить готовый Viewer через testing.ts (в production — нельзя).
import { isProduction } from '@/server/platform/env';
import type { Viewer } from './types';
import { buildViewer } from './viewer';

let override: (() => Promise<Viewer>) | null = null;

export function resolveViewer(): Promise<Viewer> {
  return override ? override() : buildViewer();
}

export function overrideViewer(fn: (() => Promise<Viewer>) | null): void {
  if (fn && isProduction()) throw new Error('доступ: подмена Viewer запрещена в production');
  override = fn;
}
