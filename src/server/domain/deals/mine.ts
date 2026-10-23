// «Мои покупки» (pipeline-v2 §9.5, этап В): выигранные сделки, засчитанные сотруднику по заслуге, а не по текущему
// владельцу карточки. Чужие продажи на его нынешних клиентах в список не попадают; после передачи карточки его продажа
// остаётся. Название клиента — только пока карточка в его охвате, иначе признак «клиент передан». Вознаграждение не считаем.
import { booking } from '@crm/core';
import { NotFoundError, type Viewer } from '@/server/access';
import { getDb } from '@/server/platform/db';
import { requirePurchases, requireSpace } from './guards';
import { listMyPurchases, sumMyPurchases } from './repo.mine';
import { seesDealsOnlyAsDepartment } from './visibility';
import type { DealsDeps } from './types';

export interface MyPurchase {
  dealId: string;
  wonAt: number;
  serviceTypeKey: string | null;
  amountKzt: number | null;
  /** Только при охвате карточки; иначе null и `clientTransferred`. */
  clientId: string | null;
  clientName: string | null;
  clientTransferred: boolean;
}

export interface MyPurchases {
  items: MyPurchase[];
  /** Текущий месяц (по поясу установки) для шапки колонки «Покупка». */
  month: { count: number; sumKzt: number };
}

const LIMIT = 200;

/** Границы месяца, в который попадает `now`, в поясе установки: [начало, начало следующего). */
export function monthBounds(timeZone: string, now: number): { fromMs: number; toMs: number } {
  const day = booking.epochToLocalDate(timeZone, now);
  const [y, m] = [Number(day.slice(0, 4)), Number(day.slice(5, 7))];
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return { fromMs: booking.localDayStart(timeZone, `${day.slice(0, 7)}-01`), toMs: booking.localDayStart(timeZone, next) };
}

export async function listMine(deps: DealsDeps, viewer: Viewer): Promise<MyPurchases> {
  requirePurchases();
  const spaceId = requireSpace(viewer);
  // Отдел передачи сделок как таковых не видит (D-300): тот же ответ, что на несуществующее
  if (seesDealsOnlyAsDepartment(viewer)) throw new NotFoundError();
  const now = deps.now();
  const settings = await deps.settings(spaceId, now);
  const db = await getDb();
  const month = monthBounds(settings.timeZone, now);
  const [rows, sum] = await Promise.all([
    listMyPurchases(viewer, db.sql, { spaceId, fromMs: 0, toMs: Number.MAX_SAFE_INTEGER, limit: LIMIT }),
    sumMyPurchases(viewer, db.sql, { spaceId, ...month }),
  ]);
  return {
    items: rows.map((r) => ({
      dealId: r.dealId,
      wonAt: Number(r.wonAt),
      serviceTypeKey: r.serviceTypeKey,
      amountKzt: r.amountKzt === null ? null : Number(r.amountKzt),
      clientId: r.clientId,
      clientName: r.clientName,
      clientTransferred: !r.clientVisible,
    })),
    month: { count: sum.count, sumKzt: Number(sum.sumKzt) },
  };
}
