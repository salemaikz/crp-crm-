// Настройки для экрана «Звонить»: кнопки итогов, причины, сроки перезвона, цель «звонков в час», календарь.
// Читается из активных настроек пространства зрителя; ПДн здесь нет, только подписи и числа.
import { config as coreConfig } from '@crm/core';
import type { Viewer } from '@/server/access';
import { getActiveConfig } from '@/server/platform/config/active';
import type { CallConfig, CallbackPreset, OutcomeButton, OutcomeField } from '@/ui/call/types';

type L = { ru: string; kk?: string | undefined };
const text = (l: L): string => l.ru;
const live = <T extends { archived?: boolean | undefined }>(xs: readonly T[]): T[] => xs.filter((x) => x.archived !== true);

/** Мастер записи (B3a): `<адрес>?card=<id>`. */
export const BOOK_HREF = '/book';

/** Окно отмены итога по умолчанию, если настройки не задают. */
const DEFAULT_UNDO_SECONDS = 5;
/** Праздники отдаём на 120 дней вперёд: хватает, чтобы найти ближайший рабочий день. */
const HOLIDAY_HORIZON_DAYS = 120;

export async function loadCallConfig(viewer: Viewer): Promise<CallConfig | null> {
  const cfg = await getActiveConfig();
  const space = Object.values(cfg.spaces).find((s) => s.spaceId === viewer.spaceId);
  if (!space) return null;
  const doc = space.doc;
  const g = cfg.global.doc;
  const calling = doc.calling;

  const fieldDefs = [...g.fields, ...(doc.fields ?? [])];
  const outcomeFields: Record<string, OutcomeField> = {};
  const outcomes: OutcomeButton[] = live(calling.outcomes)
    .sort((a, b) => a.order - b.order)
    .map((o) => {
      for (const key of o.requires.fields) {
        const f = fieldDefs.find((x) => x.key === key);
        if (f && !outcomeFields[key]) {
          outcomeFields[key] = {
            key,
            label: text(f.label),
            type: f.type === 'select' ? 'select' : 'text',
            options: f.type === 'select' ? live(f.options).map((x) => ({ key: x.key, label: text(x.label) })) : [],
          };
        }
      }
      const group = o.reasonGroup ? (doc.reasons[o.reasonGroup] ?? []) : [];
      return {
        key: o.key,
        kind: o.kind,
        label: text(o.label),
        color: o.color,
        requires: { ...o.requires, fields: [...o.requires.fields] },
        reasons: live(group).map((r) => ({ key: r.key, label: text(r.label), needsText: r.needsText })),
      };
    });

  const callbackPresets: CallbackPreset[] = [];
  for (const raw of calling.callbackPresets) {
    const step = coreConfig.parseStep(raw);
    if (step?.kind === 'plus') callbackPresets.push({ kind: 'plus', minutes: step.minutes });
    else if (step?.kind === 'nextWorkday') callbackPresets.push({ kind: 'nextWorkday', time: step.time });
  }

  const horizon = new Date(viewer.now + HOLIDAY_HORIZON_DAYS * 86_400_000).toISOString().slice(0, 10);
  const cardFields = live(fieldDefs)
    .filter((f) => f.showOn.card && (f.object === 'client' || f.object === 'card'))
    .map((f) => ({
      key: f.key,
      label: text(f.label),
      options: Object.fromEntries(f.options.map((x) => [x.key, text(x.label)])),
    }));

  return {
    userId: viewer.userId,
    outcomes,
    undoMs: (calling.undoSeconds ?? DEFAULT_UNDO_SECONDS) * 1000,
    lprNoRequiresInfo: calling.lprNoRequiresInfo,
    lprRequiredOnContact: calling.lprRequiredOnContact,
    outcomeFields,
    callbackPresets,
    callsPerHourTarget: doc.reports.callsPerHourTarget,
    timeZone: g.org.timezone,
    calendar: {
      workdays: [...g.calendar.workdays],
      holidays: g.calendar.holidays.filter((h) => h.date >= viewer.today && h.date <= horizon).map((h) => ({ date: h.date, kind: h.kind })),
    },
    cardFields,
    bookHref: BOOK_HREF,
  };
}
