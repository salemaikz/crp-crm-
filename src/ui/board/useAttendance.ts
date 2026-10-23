'use client';

// Отметка явки тумблером «Был на …» (pipeline-v2 §5.2): существующий `POST /api/bookings/[id]/attendance`. Проверки
// (после начала, автомат статусов, охват, «чужое = 404») делает сервер; здесь запрос, подсказка и перечитывание доски.
import { useTranslations } from 'next-intl';
import { useCallback, useState } from 'react';
import { useToast } from '@/ui/kit';
import { attendanceRequest, eventKindOf, type AttendKind } from './attend';
import type { useBoardData } from './useBoardData';
import type { useBoardRuntime } from './useBoardRuntime';
import type { BoardCardDto, BoardConfig } from './types';

type Data = ReturnType<typeof useBoardData>;
type Runtime = ReturnType<typeof useBoardRuntime>;

export function useAttendance(deps: { config: Pick<BoardConfig, 'eventBehaviors'>; runtime: Runtime; data: Data }) {
  const { config, runtime, data } = deps;
  const t = useTranslations('board');
  const toast = useToast();
  const [busy, setBusy] = useState<string[]>([]);

  const mark = useCallback(
    async (card: BoardCardDto, kind: AttendKind) => {
      // Тумблер вида, которого у записи нет, ничего не отправляет
      if (eventKindOf(card, config.eventBehaviors) !== kind) return;
      const req = attendanceRequest(card, 'attended', globalThis.crypto.randomUUID());
      if (!req || runtime.lockedRef.current) return;
      if (runtime.foreign()) return runtime.leave();
      if (!navigator.onLine) {
        toast.show({ message: t('toast.needNetwork'), tone: 'info' });
        return;
      }
      setBusy((x) => [...x, card.id]);
      try {
        const res = await runtime.safeFetch(req.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(req.body) });
        if (res.ok) toast.show({ message: t('toast.attended', { name: card.name }), tone: 'success' });
        else if (res.status === 403) toast.show({ message: t('toast.attendForbidden'), tone: 'danger' });
        else if (res.status === 404) toast.show({ message: t('toast.unavailable'), tone: 'danger' });
        else if (res.status === 423) toast.show({ message: t('toast.readOnly'), tone: 'danger' });
        else if (res.status === 409) toast.show({ message: t('toast.changed'), tone: 'danger' });
        else toast.show({ message: t('toast.failed'), tone: 'danger' });
      } catch {
        if (!runtime.lockedRef.current) toast.show({ message: t('toast.needNetwork'), tone: 'info' });
      } finally {
        setBusy((x) => x.filter((id) => id !== card.id));
        void data.reload();
      }
    },
    [config.eventBehaviors, runtime, data, toast, t],
  );

  return { mark, busy };
}
