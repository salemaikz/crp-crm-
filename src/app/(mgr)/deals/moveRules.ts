// Правила переноса сделки на доске (B8, D-266, дизайн §4.3). Чистая логика без React и сети: решает, что делать
// при переносе плитки в колонку. Последнее слово всё равно за сервером (`POST /api/deals/[id]/stage`).
import type { BoardFieldDef, BoardStage, DealTile, DealsBoard, MissingCode } from '@/server/domain/deals/boardTypes';

export type BlockReason = 'readonly' | 'back' | 'booking' | 'attendance' | 'field_forbidden' | 'restricted';

export type MoveDecision =
  | { kind: 'noop' }
  /** Этап «выигран»: форма покупки (B6). */
  | { kind: 'purchase' }
  /** Этап «проигран»: диалог причины (B6). */
  | { kind: 'lose' }
  | { kind: 'blocked'; reason: BlockReason }
  /** Не хватает следующего шага и/или полей: панель только с недостающим, отправка по явному «Перенести». */
  | { kind: 'panel'; nextStep: boolean; fields: string[] }
  /** Всё есть: плитка переезжает сразу, на сервер уходит через 5 с, пока можно «Отменить». */
  | { kind: 'instant' };

type Ctx = Pick<DealsBoard, 'can' | 'fieldDefs'> & { stages: readonly BoardStage[] };

const fieldKey = (c: MissingCode): string | null => (c.startsWith('field:') ? c.slice('field:'.length) : null);

export function decideMove(ctx: Ctx, tile: Pick<DealTile, 'stageKey' | 'missing'>, targetKey: string): MoveDecision {
  const from = ctx.stages.find((s) => s.key === tile.stageKey);
  const to = ctx.stages.find((s) => s.key === targetKey);
  if (!from || !to || from.key === to.key) return { kind: 'noop' };
  if (to.kind === 'won') return ctx.can.purchase ? { kind: 'purchase' } : { kind: 'blocked', reason: 'readonly' };
  if (to.kind === 'lost') return ctx.can.lose ? { kind: 'lose' } : { kind: 'blocked', reason: 'readonly' };
  if (!ctx.can.edit) return { kind: 'blocked', reason: 'readonly' };
  if (to.order < from.order && !ctx.can.moveBack) return { kind: 'blocked', reason: 'back' };
  const missing = tile.missing[to.key] ?? [];
  if (missing.includes('restricted')) return { kind: 'blocked', reason: 'restricted' };
  if (missing.includes('booking')) return { kind: 'blocked', reason: 'booking' };
  if (missing.includes('attendance')) return { kind: 'blocked', reason: 'attendance' };
  const nextStep = missing.includes('next_step');
  const fields = missing.map(fieldKey).filter((k): k is string => k !== null);
  if (fields.some((k) => ctx.fieldDefs.find((d) => d.key === k)?.editable !== true)) return { kind: 'blocked', reason: 'field_forbidden' };
  return nextStep || fields.length > 0 ? { kind: 'panel', nextStep, fields } : { kind: 'instant' };
}

/** Определения полей для панели: только недостающие, в порядке этапа. */
export function panelFields(defs: readonly BoardFieldDef[], keys: readonly string[]): BoardFieldDef[] {
  return keys.map((k) => defs.find((d) => d.key === k)).filter((d): d is BoardFieldDef => d !== undefined);
}

/** Ответ маршрута переноса (B6 §6) → что делать доске. */
export type MoveVerdict =
  | { kind: 'ok' }
  /** 409 без `detail`: устаревшая версия — перечитать доску. */
  | { kind: 'stale' }
  /** Отказ по коду (`409 {detail}`, `400 <код>`): вернуть плитку, тост `deals.errors.<код>`. */
  | { kind: 'code'; code: string; fields: string[] }
  | { kind: 'forbidden' }
  | { kind: 'readonly' }
  | { kind: 'login' }
  | { kind: 'network' };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export function classifyMoveResponse(status: number, json: unknown): MoveVerdict {
  if (status >= 200 && status < 300) return { kind: 'ok' };
  if (status === 401) return { kind: 'login' };
  if (status === 403) return { kind: 'forbidden' };
  if (status === 423) return { kind: 'readonly' };
  const body = isObj(json) ? json : {};
  const fields = Array.isArray(body.fields) ? body.fields.filter((x): x is string => typeof x === 'string') : [];
  if (status === 409) return typeof body.detail === 'string' ? { kind: 'code', code: body.detail, fields } : { kind: 'stale' };
  if (status === 400) return { kind: 'code', code: typeof body.detail === 'string' ? body.detail : typeof body.error === 'string' ? body.error : 'bad_request', fields };
  if (status === 404) return { kind: 'code', code: 'not_found', fields };
  return { kind: 'network' };
}

/** Что делать доске с отказом сервера по требованиям этапа или закрытию сделки (B6 §6). */
export type RefusalRoute =
  /** Открыть панель с недостающим: следующий шаг и/или поля. */
  | { kind: 'panel'; nextStep: boolean; fields: string[] }
  /** Нет записи или явки: переносом не решается. */
  | { kind: 'blocked'; reason: 'booking' | 'attendance' }
  /** Покупка и проигрыш — отдельные формы B6. */
  | { kind: 'purchase' }
  | { kind: 'lose' }
  | { kind: 'toast' };

export function routeRefusal(code: string, fields: readonly string[], known: readonly string[] = []): RefusalRoute {
  if (code === 'use_purchase') return { kind: 'purchase' };
  if (code === 'use_lose') return { kind: 'lose' };
  if (code === 'next_step_required') return { kind: 'panel', nextStep: true, fields: [...known] };
  if (code === 'stage_fields_required') {
    if (fields.includes('booking')) return { kind: 'blocked', reason: 'booking' };
    if (fields.includes('attendance')) return { kind: 'blocked', reason: 'attendance' };
    return { kind: 'panel', nextStep: false, fields: [...fields] };
  }
  return { kind: 'toast' };
}
