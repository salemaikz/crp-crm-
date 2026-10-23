// Ссылочные проверки ключей воронки v2 одного пространства (docs/pipeline-v2-design.md §2.2, §4.1, §8.1).
import type { SpaceConfigV1 } from './schema/v1.js';

type P = (string | number)[];

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
  if (sp.reasons.written_off !== undefined) {
    const lost = sp.reasons.deal_lost ?? [];
    if (!lost.some((r) => r.system === 'write_off' || r.key === 'other')) {
      issue(at('reasons', 'deal_lost'), 'при reasons.written_off в deal_lost нужна причина с system «write_off» или ключ «other»');
    }
  }

  // доска
  const board = sp.board;
  if (board === undefined) return;
  const byState = new Map<string, { col: number; typed: boolean }[]>();
  board.columns.forEach((c, i) => {
    const typed = (c.eventTypes ?? []).length > 0;
    (c.eventTypes ?? []).forEach((e, j) => ref(at('board', 'columns', i, 'eventTypes', j), e, eventTypes, 'типа мероприятия'));
    if (typed && !c.states.includes('agreed')) issue(at('board', 'columns', i, 'eventTypes'), 'eventTypes — только у колонки с состоянием agreed');
    for (const s of c.states) byState.set(s, [...(byState.get(s) ?? []), { col: i, typed }]);
    (c.drop ?? []).forEach((d, j) => {
      const group = sp.reasons[d.kind];
      if (group === undefined) issue(at('board', 'columns', i, 'drop', j, 'kind'), `нет группы причин «${d.kind}»`);
      else if (!group.some((r) => r.key === d.reason)) issue(at('board', 'columns', i, 'drop', j, 'reason'), `нет причины «${d.reason}» в группе «${d.kind}»`);
    });
  });
  for (const [state, cols] of byState) {
    if (cols.length > 1 && cols.some((c) => !c.typed)) {
      issue(at('board', 'columns', cols[1]!.col, 'states'), `состояние «${state}» в нескольких колонках без eventTypes`);
    }
  }
  if (board.agreedFallback !== undefined) {
    const col = board.columns.find((c) => c.key === board.agreedFallback);
    if (!col) issue(at('board', 'agreedFallback'), `нет колонки «${board.agreedFallback}»`);
    else if (!col.states.includes('agreed')) issue(at('board', 'agreedFallback'), 'колонка agreedFallback должна содержать состояние agreed');
  }
}
