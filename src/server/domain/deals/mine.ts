// «Мои покупки» (pipeline-v2 §9.5, этап В): выигранные сделки, засчитанные сотруднику по заслуге, а не по текущему
// владельцу карточки. Чужие продажи на его нынешних клиентах в список не попадают; после передачи карточки его продажа
// остаётся. Название клиента — только пока карточка в его охвате, иначе признак «клиент передан». Вознаграждение не считаем.
import { booking } from '@crm/core';
import { NotFoundError, type Viewer } from '@/server/access';
import { getDb } from '@/server/platform/db';
import { isFeatureEnabled } from '@/server/platform/flags';
import { requirePurchases, requireSpace } from './guards';
import { listMyPurchases, sumMyPurchases } from './repo.mine';
import { seesDealsOnlyAsDepartment } from './visibility';
import type { DealsDeps } from './types';

export interface MyPurchase {
  dealId: string;
  wonAt: number;
  serviceTypeKey: string | null;
  /** Тот же ключ типа услуги под именем DTO круга 3 (R3-К1); null — типа нет. */
  serviceType: string | null;
  /** Ключ варианта услуги (D-357); null — покупка без варианта. Подпись берёт устройство из настроек. */
  variant: string | null;
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
  /** Курсор следующей страницы (`wonAt:id`) или null, если список закончился. */
  next: string | null;
}

const LIMIT = 200;

/** Границы месяца, в который попадает `now`, в поясе установки: [начало, начало следующего). */
export function monthBounds(timeZone: string, now: number): { fromMs: number; toMs: number } {
  const day = booking.epochToLocalDate(timeZone, now);
  const [y, m] = [Number(day.slice(0, 4)), Number(day.slice(5, 7))];
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return { fromMs: booking.localDayStart(timeZone, `${day.slice(0, 7)}-01`), toMs: booking.localDayStart(timeZone, next) };
}

function parseCursor(raw: string | null | undefined): { wonAt: number; id: string } | null {
  if (!raw) return null;
  const m = /^(\d{1,16}):([\w-]{1,64})$/.exec(raw);
  if (!m) throw new NotFoundError();
  return { wonAt: Number(m[1]), id: m[2]! };
}

export async function listMine(deps: DealsDeps, viewer: Viewer, opts: { cursor?: string | null } = {}): Promise<MyPurchases> {
  requirePurchases();
  // Раздел — часть доски этапа В (pipeline-v2 §9.5): без OP_BOARD API доски отвечает 404 (§8.3)
  if (!isFeatureEnabled('OP_BOARD')) throw new NotFoundError();
  const spaceId = requireSpace(viewer);
  // Отдел передачи сделок как таковых не видит (D-300): тот же ответ, что на несуществующее
  if (seesDealsOnlyAsDepartment(viewer)) throw new NotFoundError();
  const after = parseCursor(opts.cursor);
  const now = deps.now();
  const settings = await deps.settings(spaceId, now);
  const db = await getDb();
  const month = monthBounds(settings.timeZone, now);
  const [rows, sum] = await Promise.all([
    listMyPurchases(viewer, db.sql, { spaceId, fromMs: 0, toMs: Number.MAX_SAFE_INTEGER, limit: LIMIT + 1, after }),
    sumMyPurchases(viewer, db.sql, { spaceId, ...month }),
  ]);
  const page = rows.slice(0, LIMIT);
  const last = page[page.length - 1];
  return {
    next: rows.length > LIMIT && last ? `${last.wonAt}:${last.dealId}` : null,
    items: page.map((r) => ({
      dealId: r.dealId,
      wonAt: Number(r.wonAt),
      serviceTypeKey: r.serviceTypeKey,
      serviceType: r.serviceTypeKey === null || r.serviceTypeKey === '' ? null : r.serviceTypeKey,
      variant: r.serviceVariantKey === null || r.serviceVariantKey === '' ? null : r.serviceVariantKey,
      amountKzt: r.amountKzt === null ? null : Number(r.amountKzt),
      clientId: r.clientId,
      clientName: r.clientName,
      clientTransferred: !r.clientVisible,
    })),
    month: { count: sum.count, sumKzt: Number(sum.sumKzt) },
  };
}
