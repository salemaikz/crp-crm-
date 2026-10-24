'use client';

// Шторка ответа обзвона «подтвердить явку» (D-355, round3 §1.3): вместо «Итога звонка» после звонка по плитке обзвона.
// Три крупные кнопки: «Придёт» (зелёная), «Не придёт» (раскрывается на месте: причина из настроек и срок по касанию),
// «Не дозвонился»; ссылка «Другой итог…» ведёт в обычную шторку итога. Без сети «Придёт» и «Не придёт» погашены.
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Check } from 'lucide-react';
import { BottomSheet, Button } from '@/ui/kit';
import { CallbackPicker } from '@/ui/call/CallbackPicker';
import { defaultDue } from '@/ui/call/callbackPlan';
import { EMPTY_DRAFT, type SheetDraft } from '@/ui/call/types';
import { offlineDisabled } from './confirm';
import type { BoardCardDto, BoardConfig } from './types';

export interface ConfirmSheetProps {
  card: BoardCardDto;
  config: Pick<BoardConfig, 'call' | 'eventLabels' | 'reasonLabels'>;
  /** Причина «не придёт» из настроек обзвона: зафиксирована, не выбирается. */
  declineReason: string;
  online: boolean;
  /** Открыть сразу раскрытым «Не придёт» (ответ без звонка, из «⋯»). */
  startInDecline?: boolean;
  busy: boolean;
  onYes: () => void;
  /** Только после звонка: «Не дозвонился» и «Другой итог…». */
  onNoAnswer?: () => void;
  onOther?: () => void;
  onDecline: (callbackAt: number) => void;
  onClose: () => void;
}

export function ConfirmSheet({ card, config, declineReason, online, startInDecline = false, busy, onYes, onNoAnswer, onOther, onDecline, onClose }: ConfirmSheetProps) {
  const t = useTranslations('board');
  const f = useFormatter();
  const call = config.call;
  const [openedAt] = useState(() => Date.now());
  const [declining, setDeclining] = useState(startInDecline);
  // Срок по касанию выбран сразу (подсказка расписания), как в шторке перезвона
  const [draft, setDraft] = useState<SheetDraft>(() => {
    const due = defaultDue({ steps: call.callbackSchedule, touches: card.callbackTouches, now: Date.now(), tz: call.timeZone, cal: call.calendar, windowStart: call.callWindowStart });
    return { ...EMPTY_DRAFT, callbackAt: due?.at ?? null, callbackPrecision: 'day' };
  });
  const off = offlineDisabled(online);
  const ev = card.event;
  const subtitle = ev
    ? t('confirm.sheet.subtitle', {
        event: config.eventLabels[ev.type] ?? t('chip.eventUnknown'),
        day: f.dateTime(ev.startsAt, { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: call.timeZone }),
        time: f.dateTime(ev.startsAt, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: call.timeZone }),
      })
    : undefined;
  const dayText = (at: number) => `${f.dateTime(at, { weekday: 'short', timeZone: call.timeZone })} ${f.dateTime(at, { day: '2-digit', month: '2-digit', timeZone: call.timeZone })}`;
  const reasonText = config.reasonLabels[declineReason] ?? t('chip.reasonOther');

  return (
    <BottomSheet
      open
      onClose={onClose}
      closeLabel={t('confirm.sheet.close')}
      title={card.name}
      {...(subtitle !== undefined ? { description: subtitle } : {})}
      footer={
        declining ? (
          <Button variant="success" size="lg" block disabled={busy || off.decline || draft.callbackAt === null} onClick={() => draft.callbackAt !== null && onDecline(draft.callbackAt)} data-testid="confirm-decline-save">
            {draft.callbackAt !== null ? t('confirm.sheet.saveDay', { day: dayText(draft.callbackAt) }) : t('confirm.sheet.save')}
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-3" data-testid="confirm-sheet">
        {(off.yes || off.decline) && (
          <p className="text-sm" role="status" style={{ color: 'var(--text-2)' }} data-testid="confirm-offline">
            {t('confirm.sheet.needNetwork')}
          </p>
        )}
        <Button variant="success" size="lg" block disabled={busy || off.yes} onClick={onYes} data-testid="confirm-yes">
          {t('confirm.sheet.yes')}
        </Button>
        {declining ? (
          <div className="flex flex-col gap-3 rounded-[var(--radius-control)] border-2 p-3" style={{ borderColor: 'var(--text)', background: 'var(--surface-selected)' }} data-testid="confirm-decline">
            <p className="flex items-center gap-2 font-semibold">
              <Check aria-hidden="true" size={18} />
              {t('confirm.sheet.no')}
            </p>
            <div className="flex flex-col gap-1">
              <span className="text-sm font-semibold">{t('confirm.sheet.reason')}</span>
              <span className="font-medium" data-testid="confirm-reason">
                {reasonText}
              </span>
            </div>
            <CallbackPicker config={call} draft={draft} touches={card.callbackTouches} openedAt={openedAt} dayOnly onChange={(patch) => setDraft((d) => ({ ...d, ...patch, callbackPrecision: 'day' }))} />
          </div>
        ) : (
          <Button variant="secondary" size="lg" block disabled={busy || off.decline} onClick={() => setDeclining(true)} data-testid="confirm-no">
            {t('confirm.sheet.no')}
          </Button>
        )}
        {onNoAnswer && !declining && (
          <Button variant="secondary" size="lg" block disabled={busy || off.noAnswer} onClick={onNoAnswer} data-testid="confirm-no-answer">
            {t('confirm.sheet.noAnswer')}
          </Button>
        )}
        {onOther && !declining && (
          <Button variant="quiet" block onClick={onOther} data-testid="confirm-other">
            {t('confirm.sheet.other')}
          </Button>
        )}
      </div>
    </BottomSheet>
  );
}
