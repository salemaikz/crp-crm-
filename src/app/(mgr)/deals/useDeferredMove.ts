'use client';

// Обёртка над DeferredMoves для React (B8, D-266): таймеры браузера, отправка по истечении окна и немедленная
// отправка при уходе со страницы (`pagehide`, fetch с keepalive). Какие сделки ждут отправки — для приглушения плиток.
import { useCallback, useEffect, useRef, useState } from 'react';
import { DeferredMoves, UNDO_DELAY_MS, type MoveRequest } from './deferredMove';

export function useDeferredMove(send: (move: MoveRequest, o: { keepalive: boolean }) => void) {
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  });
  const [waiting, setWaiting] = useState<ReadonlySet<string>>(new Set());
  const [queue] = useState(
    () =>
      new DeferredMoves({
        delayMs: UNDO_DELAY_MS,
        timers: { set: (fn, ms) => window.setTimeout(fn, ms), clear: (h) => window.clearTimeout(h as number) },
        send: (m, o) => sendRef.current(m, o),
      }),
  );

  const sync = useCallback(() => {
    // Список ожидающих читаем после каждого изменения: размер мал (единицы)
    setWaiting(new Set(queue.dealIds()));
  }, [queue]);

  useEffect(() => {
    const onHide = () => {
      queue.flushAll();
    };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [queue]);

  const schedule = useCallback(
    (move: MoveRequest) => {
      const replaced = queue.schedule(move);
      sync();
      return replaced;
    },
    [queue, sync],
  );
  const cancel = useCallback(
    (opId: string) => {
      const m = queue.cancel(opId);
      sync();
      return m;
    },
    [queue, sync],
  );
  /** Таймер сработал и перенос ушёл: убрать из «ожидающих». */
  const settled = useCallback(() => sync(), [sync]);

  return { schedule, cancel, settled, waiting, pending: () => queue.size };
}
