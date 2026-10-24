'use client';
// Подсказка первого входа на доску (S4): «Удерживайте плитку, чтобы перенести». Показывается один раз на сотрудника
// на этом устройстве; отметка — в localStorage под ключом без ПДн (идентификатор сотрудника). Стоит над нижним
// меню и не закрывает вкладки колонок; сама плашка не перехватывает касания плиток под ней (кликабельны только ссылка и кнопка), которые лежат вверху экрана. Оболочка по пути: страница доски не меняется.
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSyncExternalStore } from 'react';
import { buttonClass } from '@/ui/kit';
import { BOARD_TIP_PATH, boardTipKey } from './boardTip';

export type BoardTipProps = { userId: string; hold: string; link: string; ok: string };

const listeners = new Set<() => void>();
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => void listeners.delete(cb);
};

export function BoardTip({ userId, hold, link, ok }: BoardTipProps) {
  const pathname = usePathname();
  // отметка читается из localStorage уже в браузере; на сервере подсказки нет (нет мигания и расхождения гидрации)
  const unseen = useSyncExternalStore(
    subscribe,
    () => {
      try {
        return window.localStorage.getItem(boardTipKey(userId)) === null;
      } catch {
        // хранилище недоступно: подсказку не показываем, чтобы она не вылезала при каждом заходе
        return false;
      }
    },
    () => false,
  );
  if (pathname !== BOARD_TIP_PATH || !unseen) return null;
  const dismiss = () => {
    try {
      window.localStorage.setItem(boardTipKey(userId), '1');
    } catch {
      // нечего сохранять
    }
    listeners.forEach((cb) => cb());
  };
  return (
    <div
      role="note"
      data-testid="board-tip"
      className="pointer-events-none fixed inset-x-0 z-20 mx-auto flex max-w-md items-center gap-3 rounded-xl border p-3 md:right-auto md:left-[calc(var(--sidebar-w)+var(--gutter))] md:mx-0"
      style={{
        bottom: 'calc(var(--bottom-nav-h) + 12px)',
        width: 'calc(100% - 2 * var(--gutter))',
        borderColor: 'var(--border)',
        background: 'var(--surface)',
        color: 'var(--text)',
      }}
    >
      <p className="min-w-0 flex-1 text-sm">
        {hold}{' '}
        <Link href="/help#board" onClick={dismiss} className="pointer-events-auto underline" style={{ color: 'var(--brand-ink)' }}>
          {link}
        </Link>
      </p>
      <button type="button" onClick={dismiss} className={buttonClass({ variant: 'secondary', className: 'pointer-events-auto' })} data-testid="board-tip-ok">
        {ok}
      </button>
    </div>
  );
}
