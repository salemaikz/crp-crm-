'use client';

// Выход из «Договорились» (№ 33, pipeline-v2 §3.2): только онлайн, без очереди устройства. После подтверждения плитка
// сразу переезжает, запрос уходит через окно «Отменить» (undoMs); при уходе со страницы — сразу, с keepalive
// (как ручное списание № 32). Повтор с тем же `opId` сервер принимает как прежний результат (идемпотентность).
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '@/ui/kit';
import { exitBody, exitOutcome, planExit, type Due, type ExitTo } from './exit';
import type { useBoardData } from './useBoardData';
import type { useBoardRuntime } from './useBoardRuntime';
import type { BoardCardDto, BoardConfig } from './types';

type Data = ReturnType<typeof useBoardData>;
type Runtime = ReturnType<typeof useBoardRuntime>;

export interface ExitRequest {
  card: BoardCardDto;
  to: ExitTo;
  reasonCode: string;
  reasonText: string;
  due: Due | null;
  attendance: { bookingId: string; to: 'attended' | 'no_show' } | null;
}

interface Deferred {
  timer: ReturnType<typeof setTimeout>;
  send: (keepalive: boolean) => Promise<void>;
}

export function useDeferredExit(deps: { config: Pick<BoardConfig, 'columns' | 'undoMs'>; runtime: Runtime; data: Data }) {
  const { config, runtime, data } = deps;
  const t = useTranslations('board');
  const toast = useToast();
  const [ids, setIds] = useState<string[]>([]);
  const deferred = useRef(new Map<string, Deferred>());

  const schedule = useCallback(
    (r: ExitRequest): boolean => {
      if (runtime.lockedRef.current) return false;
      if (runtime.foreign()) {
        runtime.leave();
        return false;
      }
      if (!navigator.onLine) {
        toast.show({ message: t('toast.needNetwork'), tone: 'info' });
        return false;
      }
      const { card } = r;
      const opId = globalThis.crypto.randomUUID();
      const plan = planExit(card, r.to, r.reasonCode, r.due, config.columns, Date.now());
      if (plan) data.place({ cardId: card.id, column: plan.column, patch: plan.patch, opId });
      setIds((x) => [...x, card.id]);
      const send = async (keepalive: boolean) => {
        const d = deferred.current.get(card.id);
        if (!d) return;
        clearTimeout(d.timer);
        // Больше не отменить: запись убираем сразу, чтобы повторный вызов (pagehide) не отправил её второй раз
        deferred.current.delete(card.id);
        try {
          const res = await runtime.safeFetch(`/api/cards/${encodeURIComponent(card.id)}/move`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            keepalive,
            body: JSON.stringify(exitBody({ opId, card, to: r.to, reasonCode: r.reasonCode, reasonText: r.reasonText, due: r.due, attendance: r.attendance })),
          });
          const out = exitOutcome(res.status);
          if (out !== 'ok') data.unplaceOps([opId]);
          if (out === 'gone') {
            data.drop(card.id);
            toast.show({ message: t('toast.unavailable'), tone: 'danger' });
          } else if (out === 'readOnly') toast.show({ message: t('toast.readOnly'), tone: 'danger' });
          else if (out === 'forbidden') toast.show({ message: t('toast.attendForbidden'), tone: 'danger' });
          else if (out === 'changed') toast.show({ message: t('toast.changed'), tone: 'danger' });
          else if (out === 'invalid') toast.show({ message: t('toast.invalid'), tone: 'danger' });
          else if (out === 'failed') toast.show({ message: t('toast.failed'), tone: 'danger' });
          else data.unplaceOps([opId]);
        } catch {
          data.unplaceOps([opId]);
          if (!runtime.lockedRef.current) toast.show({ message: t('toast.needNetwork'), tone: 'info' });
        } finally {
          setIds((x) => x.filter((id) => id !== card.id));
          void data.reload();
        }
      };
      const timer = setTimeout(() => void send(false), config.undoMs);
      deferred.current.set(card.id, { timer, send });
      toast.show({
        message: t('toast.moved', { name: card.name }),
        tone: 'success',
        ...(config.undoMs > 0
          ? {
              undo: {
                label: t('toast.undo'),
                onUndo: () => {
                  const d = deferred.current.get(card.id);
                  if (!d) return toast.show({ message: t('toast.alreadySent'), tone: 'info' });
                  clearTimeout(d.timer);
                  deferred.current.delete(card.id);
                  setIds((x) => x.filter((id) => id !== card.id));
                  data.unplaceOps([opId]);
                  toast.show({ message: t('toast.undone'), tone: 'neutral' });
                },
              },
              durationMs: config.undoMs,
            }
          : {}),
      });
      return true;
    },
    [runtime, config.columns, config.undoMs, data, toast, t],
  );

  // Уход со страницы: отложенные выходы отправляются сразу (keepalive)
  useEffect(() => {
    const flush = () => {
      for (const d of [...deferred.current.values()]) void d.send(true);
    };
    window.addEventListener('pagehide', flush);
    const map = deferred.current;
    return () => {
      window.removeEventListener('pagehide', flush);
      for (const d of map.values()) void d.send(true);
    };
  }, []);

  return { ids, schedule };
}
