'use client';

// Ответы обзвона «подтвердить явку» (D-355): «Придёт» — подтверждение записи, «Не придёт» — выход № 33 в «Перезвон».
// Оба — существующие серверные действия, только онлайн. opId один на действие и повторяется при сетевой ошибке
// (повтор ничего не задваивает); после ответа сервера доска перечитывается; намерение звонка закрывается после успеха.
import { useTranslations } from 'next-intl';
import { useCallback, useRef, useState } from 'react';
import { useToast } from '@/ui/kit';
import { OpIds, declineRequest, errorKeyOf, settles, yesRequest, type ConfirmRequest } from './confirm';
import { errorCodeOf } from './moves';
import type { useBoardData } from './useBoardData';
import type { useBoardRuntime } from './useBoardRuntime';
import type { BoardCardDto } from './types';

type Data = ReturnType<typeof useBoardData>;
type Runtime = ReturnType<typeof useBoardRuntime>;

export interface ConfirmContext {
  /** Ответ ушёл после звонка с плитки: намерение звонка закрывается после успеха. */
  fromCall: boolean;
}

type Sent = { kind: 'ok' } | { kind: 'error'; key: ReturnType<typeof errorKeyOf>; status: number } | { kind: 'network' };

export function useBoardConfirm(deps: { runtime: Runtime; data: Data; declineReason: string; finishCall: () => void; dayText: (at: number) => string }) {
  const { runtime, data, declineReason, finishCall, dayText } = deps;
  const t = useTranslations('board');
  const toast = useToast();
  const ids = useRef(new OpIds(() => globalThis.crypto.randomUUID()));
  const [busy, setBusy] = useState(false);

  const post = useCallback(
    async (req: ConfirmRequest): Promise<Sent> => {
      try {
        const res = await runtime.safeFetch(req.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(req.body) });
        if (res.ok) return { kind: 'ok' };
        if (!settles(res.status)) return { kind: 'network' };
        const body = (await res.json().catch(() => null)) as unknown;
        return { kind: 'error', key: errorKeyOf(res.status, errorCodeOf(body)), status: res.status };
      } catch {
        return { kind: 'network' };
      }
    },
    [runtime],
  );

  /** Общий разбор: true — действие закончено (успех или окончательный отказ), шторку можно закрывать. */
  const settle = useCallback(
    (card: BoardCardDto, action: string, sent: Sent, ctx: ConfirmContext, okMessage: string): boolean => {
      if (sent.kind === 'network') {
        // opId остаётся: повтор уйдёт с тем же и не задвоит
        toast.show({ message: t('confirm.toast.needNetwork'), tone: 'info' });
        return false;
      }
      ids.current.done(card.id, action);
      if (sent.kind === 'ok') {
        if (ctx.fromCall) finishCall();
        toast.show({ message: okMessage, tone: 'success' });
        void data.reload();
        return true;
      }
      toast.show({ message: t(`confirm.toast.${sent.key}`), tone: sent.key === 'changed' || sent.key === 'tooLate' ? 'info' : 'danger' });
      if (sent.status === 404) {
        data.drop(card.id);
        if (ctx.fromCall) finishCall();
      }
      void data.reload();
      // 409 и отказы по условиям: шторка остаётся, чтобы ответить заново по обновлённой записи (карточку берёт доска)
      return sent.status === 404;
    },
    [toast, t, data, finishCall],
  );

  const yes = useCallback(
    async (card: BoardCardDto, ctx: ConfirmContext): Promise<boolean> => {
      if (busy) return false;
      const req = yesRequest(card, ids.current.get(card.id, 'yes'));
      if (!req) return false;
      setBusy(true);
      const sent = await post(req);
      setBusy(false);
      return settle(card, 'yes', sent, ctx, t('confirm.toast.yes', { name: card.name }));
    },
    [busy, post, settle, t],
  );

  const decline = useCallback(
    async (card: BoardCardDto, callbackAt: number, ctx: ConfirmContext): Promise<boolean> => {
      if (busy) return false;
      setBusy(true);
      const sent = await post(declineRequest(card, declineReason, callbackAt, ids.current.get(card.id, 'decline')));
      setBusy(false);
      return settle(card, 'decline', sent, ctx, t('confirm.toast.no', { name: card.name, day: dayText(callbackAt) }));
    },
    [busy, post, settle, t, declineReason, dayText],
  );

  return { busy, yes, decline };
}
