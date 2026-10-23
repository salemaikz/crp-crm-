'use client';

// Перенос в «Мусор» (pipeline-v2 §3.4): быстрые причины колонки (`drop`), под ними «Другие причины…». Причина требует
// ответа «ЛПР: да/нет» (настройка lprRequiredOnContact) и текста («Другое»). «Не отвечает» — ручное списание № 32:
// онлайн, только после недозвона (оператору), поэтому при attempts = 0 погашено подсказкой «сначала позвоните».
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { BottomSheet, Button, Chip, ChipGroup, Field, Segmented, Textarea } from '@/ui/kit';
import { lprNeeded, missingFor } from '@/ui/call/validate';
import type { CallConfig, OutcomeButton } from '@/ui/call/types';
import { trashDraft, type TrashChoice } from './moves';
import type { BoardCardDto } from './types';

export interface TrashPick {
  choice: TrashChoice;
  lpr: '' | 'yes' | 'no';
  note: string;
}

export function TrashSheet({
  card,
  call,
  quick,
  more,
  onPick,
  onClose,
}: {
  card: BoardCardDto;
  call: CallConfig;
  quick: readonly TrashChoice[];
  more: readonly TrashChoice[];
  onPick: (pick: TrashPick) => void;
  onClose: () => void;
}) {
  const t = useTranslations('board');
  const [showMore, setShowMore] = useState(false);
  const [chosen, setChosen] = useState<TrashChoice | null>(null);
  const [lpr, setLpr] = useState<'' | 'yes' | 'no'>('');
  const [note, setNote] = useState('');

  // «Полный отказ» помечает номер плитки; без рабочего номера итог сервер не примет (phone_required)
  const noPhone = (c: TrashChoice) => c.kind === 'outcome' && c.outcomeKind === 'do_not_call' && !card.phone;
  const list = showMore ? [...quick, ...more] : quick;
  const idOf = (c: TrashChoice) => `${c.kind === 'outcome' ? c.outcomeKind : 'written_off'}:${c.reason}`;
  const def: OutcomeButton | null = chosen?.kind === 'outcome' ? (call.outcomes.find((o) => o.kind === chosen.outcomeKind) ?? null) : null;
  // Чего не хватает для итога: ЛПР, текст «Другое» (то же правило, что у шторки «Звонить»)
  const missing = def && chosen ? missingFor(def, trashDraft(def, chosen.reason, lpr, note, false), call) : [];
  // «ЛПР: да/нет» видно сразу, если его требует хоть один итог списка; выбрано списание - не нужно
  const anyNeedsLpr = list.some((c) => {
    const d = c.kind === 'outcome' ? call.outcomes.find((o) => o.kind === c.outcomeKind) : undefined;
    return d !== undefined && lprNeeded(d, call);
  });
  const needsLpr = chosen ? def !== null && lprNeeded(def, call) : anyNeedsLpr;
  const needsNote = chosen?.needsText === true;
  const ready = chosen !== null && !noPhone(chosen) && missing.length === 0 && (!needsNote || note.trim() !== '') && !(chosen.kind === 'write_off' && chosen.blocked);

  return (
    <BottomSheet
      open
      onClose={onClose}
      closeLabel={t('sheet.close')}
      title={t('trash.title')}
      description={card.name}
      footer={
        <Button size="lg" block disabled={!ready} onClick={() => chosen && onPick({ choice: chosen, lpr, note })} data-testid="trash-confirm">
          {t('trash.confirm')}
        </Button>
      }
    >
      <div className="flex flex-col gap-4" data-testid="trash-sheet">
        {needsLpr && (
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold">{t('trash.lpr')}</span>
            <Segmented
              label={t('trash.lpr')}
              className="min-w-0 flex-1 sm:max-w-56"
              items={[
                { id: 'yes', label: t('trash.yes'), active: lpr === 'yes', testId: 'trash-lpr-yes' },
                { id: 'no', label: t('trash.no'), active: lpr === 'no', testId: 'trash-lpr-no' },
              ]}
              onSelect={(id) => setLpr(lpr === id ? '' : (id as 'yes' | 'no'))}
            />
          </div>
        )}
        <ChipGroup label={t('trash.reasons')} className="flex-wrap">
          {list.map((c) => (
            <Chip
              key={idOf(c)}
              active={chosen !== null && idOf(chosen) === idOf(c)}
              disabled={(c.kind === 'write_off' && c.blocked !== null) || noPhone(c)}
              onClick={() => setChosen(c)}
              data-testid={`trash-reason-${idOf(c).replace(':', '-')}`}
            >
              {c.label}
            </Chip>
          ))}
          {more.length > 0 && !showMore && (
            <Chip onClick={() => setShowMore(true)} data-testid="trash-more">
              {t('trash.more')}
            </Chip>
          )}
        </ChipGroup>
        {list.some((c) => c.kind === 'write_off' && c.blocked === 'call_first') && (
          <p className="text-sm" style={{ color: 'var(--text-2)' }} data-testid="trash-call-first">
            {t('trash.callFirst')}
          </p>
        )}
        {list.some(noPhone) && (
          <p className="text-sm" style={{ color: 'var(--text-2)' }} data-testid="trash-no-phone">
            {t('trash.noPhone')}
          </p>
        )}
        {chosen && (needsNote || chosen.kind === 'outcome') && (
          <Field label={t('trash.note')} {...(needsNote ? {} : { optionalLabel: t('trash.optional') })}>
            <Textarea rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        )}
        {chosen?.kind === 'write_off' && (
          <p className="text-sm" style={{ color: 'var(--text-2)' }}>
            {t('trash.onlineOnly')}
          </p>
        )}
      </div>
    </BottomSheet>
  );
}
