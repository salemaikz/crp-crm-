// Пункты разделов справки: какие шаблоны из help.json показать зрителю и чем заполнить подстановки.
// Чистая функция: подписи интерфейса (сортировка, переносы) страница читает из локали и передаёт в `ext`.
import type { HelpData, HelpKind, HelpSectionId } from './helpData';

/** Подписи самого интерфейса (из локалей), нужные подстановкам. */
export type HelpExt = {
  sortHeat: string;
  callNext: string;
  moveTitle: string;
  moreReasons: string;
  owner: string;
  /** Надпись признака на плитке: «Был: {event}». */
  badge: (event: string) => string;
  /** Подпись цвета по имени тона; нет слова для тона — пустая строка. */
  toneWord: (tone: string) => string;
  nav: { purchases: string; duty: string; consultations: string; tasks: string };
  group: { work: string; analytics: string };
  attended: string;
  noShow: string;
};

export type HelpItem = { key: string; params: Record<string, string>; tone?: string };

export type HelpFlags = { callbackV2: boolean };

export function itemsFor(id: HelpSectionId, kind: HelpKind, data: HelpData, ext: HelpExt, flags: HelpFlags): HelpItem[] {
  const manager = kind === 'manager';
  const callback = data.byRole.callback;
  const trash = data.byRole.trash;
  switch (id) {
    case 'board': {
      const items: HelpItem[] = [
        manager
          ? { key: 'whatManager', params: { columns: data.columns.join(', '), owner: ext.owner } }
          : { key: 'what', params: { columns: data.columns.join(', ') } },
        { key: 'fireToday', params: {} },
        { key: 'fireOverdue', params: {} },
      ];
      for (const ref of [data.tones.group, data.tones.individual]) {
        const word = ref ? ext.toneWord(ref.tone) : '';
        if (ref && word) items.push({ key: 'tone', tone: ref.tone, params: { tone: word, event: ref.event, badge: ext.badge(ref.event) } });
      }
      items.push({ key: 'sort', params: { sort: ext.sortHeat } });
      if (!manager) items.push({ key: 'callNext', params: { callNext: ext.callNext } });
      return items;
    }
    case 'move':
      return manager
        ? [{ key: 'manager', params: {} }]
        : [{ key: 'hold', params: {} }, { key: 'menu', params: { move: ext.moveTitle } }, { key: 'blocked', params: { move: ext.moveTitle } }];
    case 'trash':
      return [
        data.trashReasons.length > 0
          ? { key: 'what', params: { trash, reasons: data.trashReasons.join(', '), more: ext.moreReasons } }
          : { key: 'whatNoReasons', params: { trash } },
        { key: manager ? 'closedManager' : 'closed', params: { trash } },
      ];
    case 'callback': {
      const items: HelpItem[] = [{ key: 'what', params: { callback } }];
      if (flags.callbackV2 && data.callbackReasons.length > 0) {
        items.push({ key: 'reasons', params: { reasons: data.callbackReasons.join(', ') } }, { key: 'term', params: {} });
      }
      return items;
    }
    case 'attend': {
      if (kind === 'consultant') {
        return [{ key: 'consultant', params: { consultations: ext.nav.consultations, attended: ext.attended, noShow: ext.noShow } }];
      }
      const events = [data.tones.group?.event, data.tones.individual?.event].filter((e): e is string => !!e);
      return [
        { key: 'who', params: {} },
        events.length > 0
          ? { key: 'after', params: { badge: ext.badge(events.join(' / ')), callback } }
          : { key: 'afterNoEvents', params: { callback } },
      ];
    }
    case 'purchases':
      return manager
        ? [{ key: 'manager', params: { purchases: ext.nav.purchases } }]
        : [{ key: 'what', params: { purchases: ext.nav.purchases } }, { key: 'client', params: { client: data.byRole.client } }];
    case 'duty':
      return [{ key: 'duty', params: { duty: ext.nav.duty } }];
    case 'consultations':
      return [{ key: 'day', params: { consultations: ext.nav.consultations } }];
    case 'tasks':
      return [{ key: 'buckets', params: { tasks: ext.nav.tasks } }];
    case 'reports':
      return [{ key: 'menu', params: { work: ext.group.work, analytics: ext.group.analytics } }];
  }
}
