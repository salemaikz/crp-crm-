'use client';

// Окно № 33 «Выход из «Договорились» в «Перезвон»» (pipeline-v2 §3.4, этап В): явка по записи («Пришёл / Не пришёл / не
// отмечать»), причина и срок. Переключатель виден, если мероприятие началось и у сотрудника есть право отмечать явку;
// иначе показан статус только для чтения. Причина и срок подставляются по явке и правятся вручную.
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { BottomSheet, Button, Chip, ChipGroup, Field, Segmented, Textarea } from '@/ui/kit';
import { CallbackPicker } from '@/ui/call/CallbackPicker';
import { EMPTY_DRAFT, type CallConfig, type SheetDraft } from '@/ui/call/types';
import { attendanceBlock, type ExitAttendance } from './attend';
import { autoDue, autoReason, type Due } from './exit';
import type { BoardCardDto, BoardConfig } from './types';

export interface AgreedExitSubmit {
  reasonCode: string;
  reasonText: string;
  due: Due;
  attendance: { bookingId: string; to: 'attended' | 'no_show' } | null;
}

export function AgreedExitSheet({
  card,
  config,
  now,
  onSubmit,
  onClose,
}: {
  card: BoardCardDto;
  config: Pick<BoardConfig, 'call' | 'canAttend' | 'agreedExit' | 'eventLabels'>;
  now: number;
  onSubmit: (r: AgreedExitSubmit) => void;
  onClose: () => void;
}) {
  const t = useTranslations('board');
  const call: CallConfig = config.call;
  const def = call.outcomes.find((o) => o.kind === 'callback') ?? null;
  const reasons = useMemo(() => def?.reasons ?? [], [def]);
  const block = attendanceBlock(card, config.canAttend, now);
  const [openedAt] = useState(() => now);

  // Явка → подсказки; ручной выбор причины или срока их больше не затирает
  const [att, setAtt] = useState<ExitAttendance>('none');
  const [reason, setReason] = useState('');
  const [reasonTouched, setReasonTouched] = useState(false);
  const [due, setDue] = useState<Due | null>(() => autoDue('none', card, config.agreedExit, call, openedAt));
  const [dueTouched, setDueTouched] = useState(false);
  const [note, setNote] = useState('');

  const chooseAttendance = (next: ExitAttendance) => {
    setAtt(next);
    if (!reasonTouched) setReason(autoReason(next, card, config.agreedExit, reasons));
    if (!dueTouched) setDue(autoDue(next, card, config.agreedExit, call, openedAt));
  };

  const chosen = reasons.find((r) => r.key === reason) ?? null;
  const reasonRequired = call.callbackV2 ? (def?.requires.reason ?? false) : true;
  const needsNote = chosen?.needsText === true;
  const ready = due !== null && (!reasonRequired || reason !== '') && (!needsNote || note.trim() !== '');

  const draft: SheetDraft = { ...EMPTY_DRAFT, callbackAt: due?.at ?? null, callbackPrecision: due?.precision ?? 'time' };
  const eventName = card.event ? (config.eventLabels[card.event.type] ?? t('chip.eventUnknown')) : '';

  const submit = () => {
    if (!due || !ready) return;
    const attendance = block.mode === 'switch' && block.bookingId !== null && att !== 'none' ? { bookingId: block.bookingId, to: att } : null;
    onSubmit({ reasonCode: reason, reasonText: note, due, attendance });
  };

  return (
    <BottomSheet
      open
      onClose={onClose}
      closeLabel={t('sheet.close')}
      title={t('exit.title')}
      description={card.name}
      footer={
        <Button size="lg" block disabled={!ready} onClick={submit} data-testid="exit-confirm">
          {t('exit.confirm')}
        </Button>
      }
    >
      <div className="flex flex-col gap-4" data-testid="exit-sheet">
        {block.mode !== 'hidden' && (
          <div className="flex flex-col gap-2" data-testid="exit-attendance">
            <span className="text-sm font-semibold">{t('exit.attendance', { event: eventName })}</span>
            {block.mode === 'switch' ? (
              <Segmented
                label={t('exit.attendanceLabel')}
                items={[
                  { id: 'attended', label: t('exit.attended'), active: att === 'attended', testId: 'exit-att-attended' },
                  { id: 'no_show', label: t('exit.noShow'), active: att === 'no_show', testId: 'exit-att-no_show' },
                  { id: 'none', label: t('exit.skip'), active: att === 'none', testId: 'exit-att-none' },
                ]}
                onSelect={(id) => chooseAttendance(id as ExitAttendance)}
              />
            ) : (
              <p className="text-sm" style={{ color: 'var(--text-2)' }} data-testid="exit-attendance-readonly">
                {t(`exit.status.${block.status}`)}
                {block.hint ? ` · ${t(`exit.hint.${block.hint}`)}` : ''}
              </p>
            )}
          </div>
        )}

        {reasons.length > 0 && (
          <ChipGroup label={t('exit.reason')} className="flex-wrap">
            {reasons.map((r) => (
              <Chip
                key={r.key}
                active={reason === r.key}
                onClick={() => {
                  setReasonTouched(true);
                  setReason(r.key);
                }}
                data-testid={`exit-reason-${r.key}`}
              >
                {r.label}
              </Chip>
            ))}
          </ChipGroup>
        )}

        <CallbackPicker
          config={call}
          draft={draft}
          touches={card.callbackTouches}
          openedAt={openedAt}
          onChange={(patch) => {
            setDueTouched(true);
            if (patch.callbackAt === null) setDue(null);
            else if (patch.callbackAt !== undefined) setDue({ at: patch.callbackAt, precision: patch.callbackPrecision ?? due?.precision ?? 'time' });
          }}
        />

        <Field label={t('trash.note')} {...(needsNote ? {} : { optionalLabel: t('trash.optional') })}>
          <Textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} data-testid="exit-note" />
        </Field>
      </div>
    </BottomSheet>
  );
}
