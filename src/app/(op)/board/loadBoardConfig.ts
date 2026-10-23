// Настройки доски оператора: колонки и быстрые причины «Мусора» из пресета, подписи причин и видов записи, права зрителя.
// Читается из активных настроек пространства; ПДн здесь нет, только подписи и признаки прав.
import type { Viewer } from '@/server/access';
import { loadBoardSettings } from '@/server/domain/cards/boardSettings';
import { getActiveConfig } from '@/server/platform/config/active';
import type { BoardConfig, BoardDrop, BoardReason } from '@/ui/board/types';
import { roleOfStates } from '@/ui/board/columns';
import { loadCallConfig } from '../call/loadCallConfig';

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
  };
}
