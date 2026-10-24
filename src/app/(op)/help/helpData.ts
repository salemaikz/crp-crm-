// Данные страницы «Как работать»: подписи колонок, мероприятий, причин и тонов берутся из настроек установки,
// в локали остаются только шаблоны. Чистые функции без БД и Next: страница передаёт срез настроек.
import { roleOfStates } from '@/ui/board/columns';
import type { ColumnRole } from '@/ui/board/types';

type L = { ru: string };

/** Срез документа пространства, который нужен справке. */
export type HelpDoc = {
  booking?: { eventTypes?: readonly { key: string; behavior: string; label: L; short?: L | undefined }[] | undefined } | undefined;
  reasons?: Record<string, readonly { key: string; label: L; archived?: boolean | undefined; manual?: boolean | undefined; system?: string | undefined }[] | undefined> | undefined;
};

/** Срез настроек доски (`BoardSettings`): колонки с подписью и правилами, тона. */
export type HelpBoard = {
  columns: readonly { key: string; label: string | null; def: { states: readonly string[]; drop?: readonly { kind: string; reason: string }[] | undefined } }[];
  tones: readonly { when: string; tone: string }[];
};

export type ToneRef = { tone: string; event: string };

export type HelpData = {
  /** Подписи колонок по порядку доски. */
  columns: string[];
  /** Подписи колонок каждой роли (новые, перезвон, договорённость, покупка, мусор); у роли нет колонок — пусто. */
  byRole: Record<'new' | 'callback' | 'agreed' | 'client' | 'trash', string>;
  /** Тон плитки по признаку явки и название мероприятия; нет правила или вида — null. */
  tones: { group: ToneRef | null; individual: ToneRef | null };
  /** Быстрые причины колонки «Мусор» (из `drop`). */
  trashReasons: string[];
  /** Причины перезвона, которые выбирает сотрудник. */
  callbackReasons: string[];
};

const ROLES = ['new', 'callback', 'agreed', 'client', 'trash'] as const;

/**
 * @param stateLabel подпись состояния из локали — запасная для колонки без подписи в пресете
 */
export function buildHelpData(board: HelpBoard, doc: HelpDoc, stateLabel: (state: string) => string): HelpData {
  const labelOf = (c: HelpBoard['columns'][number]): string => c.label ?? stateLabel(c.def.states[0] ?? c.key);
  const roles = new Map<ColumnRole, string[]>();
  for (const c of board.columns) {
    const role = roleOfStates(c.def.states);
    roles.set(role, [...(roles.get(role) ?? []), labelOf(c)]);
  }
  const byRole = Object.fromEntries(ROLES.map((r) => [r, (roles.get(r) ?? []).join(', ')])) as HelpData['byRole'];

  const events = doc.booking?.eventTypes ?? [];
  const eventOf = (behavior: string): string => {
    const e = events.find((x) => x.behavior === behavior);
    return e ? (e.short?.ru ?? e.label.ru) : '';
  };
  const toneOf = (when: string, behavior: string): ToneRef | null => {
    const rule = board.tones.find((t) => t.when === when);
    const event = eventOf(behavior);
    return rule && event ? { tone: rule.tone, event } : null;
  };

  const reasonLabel = (kind: string, key: string): string =>
    (doc.reasons?.[kind] ?? []).find((r) => r.key === key)?.label.ru ?? '';
  const trashReasons: string[] = [];
  for (const c of board.columns) {
    if (roleOfStates(c.def.states) !== 'trash') continue;
    for (const d of c.def.drop ?? []) {
      const label = reasonLabel(d.kind, d.reason);
      if (label && !trashReasons.includes(label)) trashReasons.push(label);
    }
  }
  const callbackReasons = (doc.reasons?.callback ?? [])
    .filter((r) => r.archived !== true && r.manual !== false && r.system === undefined)
    .map((r) => r.label.ru);

  return {
    columns: board.columns.map(labelOf),
    byRole,
    tones: { group: toneOf('attendedGroup', 'group'), individual: toneOf('attendedIndividual', 'individual') },
    trashReasons,
    callbackReasons,
  };
}

export type HelpKind = 'operator' | 'manager' | 'consultant';

/** Какую справку показать: по ключам меню роли (те же, что выбирают оболочку). */
export function helpKindOf(menu: readonly string[]): HelpKind {
  if (menu.includes('queue')) return 'operator';
  if (menu.includes('consultations')) return 'consultant';
  return 'manager';
}

export type HelpSectionId = 'board' | 'move' | 'trash' | 'callback' | 'attend' | 'purchases' | 'duty' | 'consultations' | 'tasks' | 'reports';

/** Разделы справки роли по порядку; идентификатор — якорь страницы (`/help#board`). */
export function sectionsFor(kind: HelpKind, opts: { wideCards: boolean }): HelpSectionId[] {
  if (kind === 'operator') return ['board', 'move', 'trash', 'callback', 'attend', 'purchases', 'duty'];
  if (kind === 'consultant') return ['consultations', 'attend', 'tasks'];
  return opts.wideCards ? ['board', 'move', 'trash', 'callback', 'attend', 'purchases', 'reports'] : ['reports'];
}
