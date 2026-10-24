// Настройки для экрана «Звонить»: кнопки итогов, причины, сроки перезвона, цель «звонков в час», календарь.
// Читается из активных настроек пространства зрителя; ПДн здесь нет, только подписи и числа.
import { config as coreConfig, fields as coreFields } from '@crm/core';
import type { Viewer } from '@/server/access';
import { cardFieldViewer, fieldViewer, loadClientsConfig } from '@/server/domain/clients';
import { getActiveConfig } from '@/server/platform/config/active';
import { isFeatureEnabled } from '@/server/platform/flags';
import { manualCallbackReasons } from './callbackReasons';
import type { CallConfig, CallbackPreset, OutcomeButton, OutcomeField } from '@/ui/call/types';

type L = { ru: string; kk?: string | undefined };
const text = (l: L): string => l.ru;
const live = <T extends { archived?: boolean | undefined }>(xs: readonly T[]): T[] => xs.filter((x) => x.archived !== true);

/** Окно отмены итога по умолчанию, если настройки не задают. */
const DEFAULT_UNDO_SECONDS = 5;
/** Типы полей, которые правятся на месте (datetime и user выбираются другими экранами). */
const EDITABLE_TYPES: ReadonlySet<string> = new Set(['text', 'textarea', 'email', 'url', 'phone', 'number', 'money', 'date', 'boolean', 'select', 'multiselect']);
/** Праздники отдаём на 120 дней вперёд: хватает, чтобы найти ближайший рабочий день. */
const HOLIDAY_HORIZON_DAYS = 120;

export async function loadCallConfig(viewer: Viewer): Promise<CallConfig | null> {
  const cfg = await getActiveConfig();
  const space = Object.values(cfg.spaces).find((s) => s.spaceId === viewer.spaceId);
  if (!space) return null;
  const doc = space.doc;
  const g = cfg.global.doc;
  const calling = doc.calling;
  // Воронка v2 (CALLBACK_V2): без флага шторка и карточка ведут себя как раньше, ключи v2 не читаются
  const v2 = isFeatureEnabled('CALLBACK_V2');

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
      // v2: причины перезвона — группа `reasons.callback` только с ручными; обязательность — `calling.callbackReason`,
      // а не `requires.reason` итога (§4.1). Остальные итоги не меняются.
      const viaV2 = v2 && o.kind === 'callback';
      const group = o.reasonGroup ? (doc.reasons[o.reasonGroup] ?? []) : [];
      return {
        key: o.key,
        kind: o.kind,
        label: text(o.label),
        color: o.color,
        requires: {
          ...o.requires,
          fields: [...o.requires.fields],
          ...(viaV2 ? { reason: calling.callbackReason?.required === true } : {}),
        },
        reasons: viaV2
          ? manualCallbackReasons((doc.reasons.callback ?? []).map((r) => ({ ...r, label: { ru: text(r.label) } })))
          : live(group).map((r) => ({ key: r.key, label: text(r.label), needsText: r.needsText })),
      };
    });

  const callbackPresets: CallbackPreset[] = [];
  for (const raw of calling.callbackPresets) {
    const step = coreConfig.parseStep(raw);
    if (step?.kind === 'plus') callbackPresets.push({ kind: 'plus', minutes: step.minutes });
    else if (step?.kind === 'nextWorkday') callbackPresets.push({ kind: 'nextWorkday', time: step.time });
  }

  const horizon = new Date(viewer.now + HOLIDAY_HORIZON_DAYS * 86_400_000).toISOString().slice(0, 10);
  // Права на правку поля на месте: доступ роли к полю (`edit`) и право на объект (client.edit / card.edit)
  const clientsCfg = v2 ? await loadClientsConfig(viewer) : null;
  const accessOf = (object: 'client' | 'card', key: string): string | undefined => {
    if (!clientsCfg) return undefined;
    const fv = object === 'card' ? cardFieldViewer(viewer, clientsCfg) : fieldViewer(viewer, clientsCfg);
    return coreFields.projectFor(fv, object, clientsCfg.fields, {}).fields.find((x) => x.key === key)?.access;
  };
  const cardFields = live(fieldDefs)
    .filter((f) => f.showOn.card && (f.object === 'client' || f.object === 'card'))
    .map((f) => {
      const object = f.object as 'client' | 'card';
      return {
        key: f.key,
        label: text(f.label),
        options: Object.fromEntries(f.options.map((x) => [x.key, text(x.label)])),
        object,
        type: f.type,
        editable: v2 && EDITABLE_TYPES.has(f.type) && accessOf(object, f.key) === 'edit',
        choices: live(f.options).map((x) => ({ key: x.key, label: text(x.label) })),
      };
    });

  return {
    userId: viewer.userId,
    outcomes,
    undoMs: (calling.undoSeconds ?? DEFAULT_UNDO_SECONDS) * 1000,
    lprNoRequiresInfo: calling.lprNoRequiresInfo,
    lprRequiredOnContact: calling.lprRequiredOnContact,
    outcomeFields,
    callbackPresets,
    callbackV2: v2,
    callbackSchedule: v2 && calling.callbackSchedule ? [...calling.callbackSchedule.steps] : null,
    callWindowStart: g.calendar.callWindow.start,
    callWindowEnd: g.calendar.callWindow.end,
    callsPerHourTarget: doc.reports.callsPerHourTarget,
    timeZone: g.org.timezone,
    calendar: {
      workdays: [...g.calendar.workdays],
      holidays: g.calendar.holidays.filter((h) => h.date >= viewer.today && h.date <= horizon).map((h) => ({ date: h.date, kind: h.kind })),
    },
    cardFields,
  };
}
