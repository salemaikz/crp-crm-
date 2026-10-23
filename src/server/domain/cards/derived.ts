// Кэш признаков и горячести карточки (docs/pipeline-v2-design.md §5.1, §6.1). Одна функция пересчитывает его из
// записей и выигранных сделок клиента; повтор ничего не портит; `version` и `updated_at` не меняются (иначе смена весов
// дала бы волну 409 на ручных действиях). Модули записи и сделок `cards` не пишут и зовут пересчёт через порт.
import { calling } from '@crm/core';
import type { Sql } from '@/server/platform/db';
import { loadBoardSettings } from './boardSettings';
import { selectCardIdsOfClient, selectDerivedSources, writeDerived, type DerivedSource, type DerivedWrite } from './derivedRepo';
import type { DerivedActor } from './types';

/** Горячесть и признаки одной карточки по весам пространства. */
export function derivedOf(src: DerivedSource, weights: calling.HeatWeights): DerivedWrite {
  const heat = calling.heatOf(
    {
      state: src.state as calling.CardState,
      callbackReason: src.callbackReason,
      lpr: src.lpr,
      attendedGroupAt: src.attendedGroupAt,
      attendedIndividualAt: src.attendedIndividualAt,
      lastNoShowAt: src.lastNoShowAt,
      purchasesTotal: src.purchasesTotal,
      nextCallAt: src.nextCallAt,
      nextCallPrecision: src.nextCallPrecision,
    },
    weights,
  );
  return {
    id: src.id,
    attendedGroupAt: src.attendedGroupAt,
    attendedIndividualAt: src.attendedIndividualAt,
    lastNoShowAt: src.lastNoShowAt,
    lastNoShowKind: src.lastNoShowKind,
    purchasesTotal: src.purchasesTotal,
    lastPurchaseAt: src.lastPurchaseAt,
    heat,
  };
}

export interface RefreshOptions {
  /** Пачечный пересчёт: карточку, занятую другой транзакцией, пропустить (её запись пересчитает кэш сама). */
  skipLocked?: boolean;
}

/**
 * Пересчитать кэш карточек из источника. Возвращает число изменённых строк (неизменённые не пишутся).
 * Вызывается в транзакции записи карточки (`persist`), из порта `CardPort.refreshDerived` и из задания.
 */
export async function refreshCardDerived(actor: DerivedActor, tx: Sql, cardIds: readonly string[], opts: RefreshOptions = {}): Promise<number> {
  if (cardIds.length === 0) return 0;
  const sources = await selectDerivedSources(actor, tx, [...new Set(cardIds)]);
  const weights = new Map<string, calling.HeatWeights>();
  const writes: DerivedWrite[] = [];
  for (const src of sources) {
    let w = weights.get(src.spaceId);
    if (!w) {
      w = (await loadBoardSettings(src.spaceId)).heat;
      weights.set(src.spaceId, w);
    }
    const next = derivedOf(src, w);
    const c = src.cur;
    const same =
      c.heat === next.heat &&
      c.attendedGroupAt === next.attendedGroupAt &&
      c.attendedIndividualAt === next.attendedIndividualAt &&
      c.lastNoShowAt === next.lastNoShowAt &&
      c.lastNoShowKind === next.lastNoShowKind &&
      c.purchasesTotal === next.purchasesTotal &&
      c.lastPurchaseAt === next.lastPurchaseAt;
    if (!same) writes.push(next);
  }
  return writeDerived(actor, tx, writes, { skipLocked: opts.skipLocked === true });
}

/** Порт для booking и deals (B1, этап В): пересчёт клиента в пространстве после явки, неявки, покупки и их отмены. */
export async function refreshClientDerived(actor: DerivedActor, tx: Sql, a: { spaceId: string; clientId: string }): Promise<number> {
  return refreshCardDerived(actor, tx, await selectCardIdsOfClient(actor, tx, a));
}
