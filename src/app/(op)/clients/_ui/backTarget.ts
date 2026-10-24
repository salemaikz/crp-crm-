// Куда ведёт «назад» из карточки (контракт К3). `from` — закрытый список, `tab` — только [a-z0-9_]{1,32}:
// адрес всегда собирается из своих кусков, поэтому открытого редиректа нет.

export type BackTarget = { href: string; kind: 'board' | 'list' };

const FROM_PATH: Readonly<Record<string, string>> = { board: '/board', deals: '/deals/calling' };
const TAB = /^[a-z0-9_]{1,32}$/;

const first = (v: string | string[] | undefined): string | undefined => (typeof v === 'string' ? v : undefined);

/** `boardOn` — доска включена (`OP_BOARD`); без неё возврат прежний, на список клиентов. */
export function backTarget(from: string | string[] | undefined, tab: string | string[] | undefined, boardOn: boolean): BackTarget {
  const f = first(from);
  const path = boardOn && f !== undefined && Object.hasOwn(FROM_PATH, f) ? FROM_PATH[f] : undefined;
  if (path === undefined) return { href: '/clients', kind: 'list' };
  const t = first(tab);
  return { href: t !== undefined && TAB.test(t) ? `${path}?tab=${t}` : path, kind: 'board' };
}
