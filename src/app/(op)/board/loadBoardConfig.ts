// Настройки доски оператора: колонки и быстрые причины «Мусора» из пресета, подписи причин и видов записи, права зрителя.
// Читается из активных настроек пространства; ПДн здесь нет, только подписи и признаки прав.
import type { Viewer } from '@/server/access';
import { loadBoardSettings } from '@/server/domain/cards/boardSettings';
import { getActiveConfig } from '@/server/platform/config/active';
import type { AgreedExitConfig, BoardConfig, BoardDrop, BoardReason } from '@/ui/board/types';
import type { CallbackPreset } from '@/ui/call/types';
import { roleOfStates } from '@/ui/board/columns';
import { loadCallConfig } from '../call/loadCallConfig';
import { config as coreConfig } from '@crm/core';

type L = { ru: string };
type Reason = { key: string; label: L; needsText: boolean; archived?: boolean | undefined };

export async function loadBoardConfig(viewer: Viewer): Promise<BoardConfig | null> {
  if (viewer.spaceId === null) return null;
  const call = await loadCallConfig(viewer);
  if (!call) return null;
  const [settings, cfg] = await Promise.all([loadBoardSettings(viewer.spaceId), getActiveConfig()]);
  const space = Object.values(cfg.spaces).find((s) => s.spaceId === viewer.spaceId);
  if (!space) return null;
  const doc = space.doc;
  const group = (name: string): Reason[] => ((doc.reasons as Record<string, Reason[] | undefined>)[name] ?? []).filter((r) => r.archived !== true);
  const labelIn = (kind: string, key: string): string => group(kind).find((r) => r.key === key)?.label.ru ?? key;

  const writeOffReasons: BoardReason[] = group('written_off').map((r) => ({ key: r.key, label: r.label.ru, needsText: r.needsText }));
  // Подписи причин перезвона нужны и системным (на плитке стоит «Не пришёл …»), поэтому берутся все, включая архивные
  const reasonLabels = Object.fromEntries(((doc.reasons as Record<string, Reason[] | undefined>).callback ?? []).map((r) => [r.key, r.label.ru]));
  const eventLabels = Object.fromEntries((doc.booking?.eventTypes ?? []).map((e) => [e.key, e.short?.ru ?? e.label.ru]));

  const eventTypes = doc.booking?.eventTypes ?? [];
  const attendOf = (behavior: string): string => {
    const e = eventTypes.find((x) => x.behavior === behavior);
    return e ? (e.short?.ru ?? e.label.ru) : '';
  };

  const columns = settings.columns.map((info) => ({
    key: info.key,
    label: info.label ?? '',
    role: roleOfStates(info.def.states),
    states: [...info.def.states],
    drop: (info.def.drop ?? []).map((d): BoardDrop => ({ kind: d.kind, reason: d.reason, label: labelIn(d.kind, d.reason) })),
    dropMore: info.def.dropMore === true,
  }));

  const eventBehaviors: BoardConfig['eventBehaviors'] = Object.fromEntries(eventTypes.map((e) => [e.key, e.behavior]));

  // Окно № 33: системные причины неявки и «пришёл, не купил» и срок после неявки берутся из настроек, не из кода
  type SysReason = Reason & { system?: string | undefined; eventTypes?: readonly string[] | undefined; manual?: boolean | undefined };
  const callbackReasons = ((doc.reasons as Record<string, SysReason[] | undefined>).callback ?? []).filter((r) => r.archived !== true && r.manual !== false);
  const noShowReasons: Record<string, string> = {};
  for (const r of callbackReasons) if (r.system === 'no_show') for (const type of r.eventTypes ?? []) noShowReasons[type] ??= r.key;
  const step = coreConfig.parseStep(doc.booking?.noShow?.callbackAt ?? '');
  const noShowCallback: CallbackPreset | null = step?.kind === 'plus' ? { kind: 'plus', minutes: step.minutes } : step?.kind === 'nextWorkday' ? { kind: 'nextWorkday', time: step.time } : null;
  const agreedExit: AgreedExitConfig = {
    enabled: call.callbackV2,
    noShowReasons,
    attendedReason: callbackReasons.find((r) => r.system === 'attended_no_purchase')?.key ?? null,
    noShowCallback,
  };

  const scope = viewer.grants.get('card.read');
  return {
    call,
    columns,
    writeOffReasons,
    reasonLabels,
    eventLabels,
    attendLabels: { attendedGroup: attendOf('group'), attendedIndividual: attendOf('individual') },
    canMove: viewer.grants.has('card.outcome') && !viewer.readOnly,
    scope: scope === 'own' ? 'own' : 'wide',
    canPurchases: viewer.grants.has('deal.read'),
    undoMs: call.undoMs,
    canAttend: viewer.grants.has('booking.attend') && !viewer.readOnly,
    eventBehaviors,
    agreedExit,
  };
}
