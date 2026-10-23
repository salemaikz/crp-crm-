// Ссылочные проверки ключей воронки v2 одного пространства (docs/pipeline-v2-design.md §2.2, §4.1, §8.1).
import type { SpaceConfigV1 } from './schema/v1.js';

type P = (string | number)[];

/** Группы причин, которыми карточка закрывается (быстрые причины колонки «Мусор»). */
const CLOSE_KINDS: ReadonlySet<string> = new Set(['not_target', 'not_interested', 'written_off']);

export function checkPipelineV2(
  sp: SpaceConfigV1,
  at: (...p: P) => P,
  issue: (path: P, message: string) => void,
  ref: (path: P, value: string, allowed: ReadonlySet<string>, what: string) => void,
): void {
  const eventTypes = new Set(sp.booking.eventTypes.map((e) => e.key));

  // причины: виды мероприятий существуют; write_off только в deal_lost
  for (const [group, list] of Object.entries(sp.reasons)) {
    list.forEach((r, i) => {
      (r.eventTypes ?? []).forEach((e, j) => ref(at('reasons', group, i, 'eventTypes', j), e, eventTypes, 'типа мероприятия'));
      if (r.system === 'write_off' && group !== 'deal_lost') issue(at('reasons', group, i, 'system'), 'system «write_off» допустим только в группе deal_lost');
    });
  }
  // Списание (№ 5, № 7, № 32, № 33) проигрывает открытые сделки: в справочнике нужна причина для системы.
  if (sp.reasons.deal_lost !== undefined) {
    if (!sp.reasons.deal_lost.some((r) => r.system === 'write_off' || r.key === 'other')) {
      issue(at('reasons', 'deal_lost'), 'в deal_lost нужна причина с system «write_off» или ключ «other»');
    }
  }

  // обзвон подтверждения явки (D-349): виды мероприятий и ручная живая причина перезвона
  const cc = sp.booking.confirmCall;
  if (cc !== undefined) {
    cc.eventTypes.forEach((e, j) => ref(at('booking', 'confirmCall', 'eventTypes', j), e, eventTypes, 'типа мероприятия'));
    const group = sp.reasons.callback;
    const r = group?.find((x) => x.key === cc.declineReason);
    const path = at('booking', 'confirmCall', 'declineReason');
    if (group === undefined) issue(path, 'нет группы причин «callback»');
    else if (!r) issue(path, `нет причины «${cc.declineReason}» в группе «callback»`);
    else if (r.manual === false) issue(path, 'причина отказа должна быть ручной (manual ≠ false)');
    else if (r.archived) issue(path, 'причина отказа в архиве');
  }

  // «Перезвонить» с обязательной причиной: нужна живая ручная причина, иначе итог нельзя сохранить (400 §4.4)
  if (sp.calling.callbackReason?.required === true) {
    const live = (sp.reasons.callback ?? []).some((r) => r.manual !== false && !r.archived);
    if (!live) issue(at('calling', 'callbackReason', 'required'), 'нужна живая ручная причина в группе «callback»');
  }

  // веса горячести: ключи — причины перезвона
  const heatReasons = sp.queue.heat?.reasons;
  if (heatReasons !== undefined) {
    const keys = new Set((sp.reasons.callback ?? []).map((r) => r.key));
    for (const k of Object.keys(heatReasons)) ref(at('queue', 'heat', 'reasons', k), k, keys, 'причины группы «callback»');
  }

  // доска
  const board = sp.board;
  if (board === undefined) return;
  const seenTypes = new Map<string, number>();
  const byState = new Map<string, { col: number; typed: boolean }[]>();
  board.columns.forEach((c, i) => {
    const typed = (c.eventTypes ?? []).length > 0;
    (c.eventTypes ?? []).forEach((e, j) => ref(at('board', 'columns', i, 'eventTypes', j), e, eventTypes, 'типа мероприятия'));
    if (typed) {
      const sig = [...(c.eventTypes ?? [])].sort().join(',');
      if (seenTypes.has(sig)) issue(at('board', 'columns', i, 'eventTypes'), `те же виды мероприятий, что у колонки №${seenTypes.get(sig)! + 1}`);
      else seenTypes.set(sig, i);
    }
    if (typed && !c.states.includes('agreed')) issue(at('board', 'columns', i, 'eventTypes'), 'eventTypes — только у колонки с состоянием agreed');
    for (const s of c.states) byState.set(s, [...(byState.get(s) ?? []), { col: i, typed }]);
    (c.drop ?? []).forEach((d, j) => {
      const group = sp.reasons[d.kind];
      if (!CLOSE_KINDS.has(d.kind)) issue(at('board', 'columns', i, 'drop', j, 'kind'), `«${d.kind}» не закрывает карточку`);
      else if (group === undefined) issue(at('board', 'columns', i, 'drop', j, 'kind'), `нет группы причин «${d.kind}»`);
      else if (!group.some((r) => r.key === d.reason)) issue(at('board', 'columns', i, 'drop', j, 'reason'), `нет причины «${d.reason}» в группе «${d.kind}»`);
    });
  });
  for (const [state, cols] of byState) {
    if (cols.length > 1 && cols.some((c) => !c.typed)) {
      issue(at('board', 'columns', cols[1]!.col, 'states'), `состояние «${state}» в нескольких колонках без eventTypes`);
    }
  }
  // несколько колонок с agreed: карточка вне перечисленных видов попадёт только в agreedFallback
  const agreedCols = byState.get('agreed') ?? [];
  if (agreedCols.length > 1 && board.agreedFallback === undefined) {
    issue(at('board', 'agreedFallback'), 'колонок с состоянием agreed несколько — нужен agreedFallback');
  }
  if (board.agreedFallback !== undefined) {
    const col = board.columns.find((c) => c.key === board.agreedFallback);
    if (!col) issue(at('board', 'agreedFallback'), `нет колонки «${board.agreedFallback}»`);
    else if (!col.states.includes('agreed')) issue(at('board', 'agreedFallback'), 'колонка agreedFallback должна содержать состояние agreed');
  }
}
