'use client';

// Перенос в «Мусор» (pipeline-v2 §3.4, ui-polish §9.3): быстрые причины колонки (`drop`), под ними «Другие причины…»
// группами по виду итога с последствием. Причина требует ответа «ЛПР: да/нет» (настройка lprRequiredOnContact) и текста
// («Другое»). «Не отвечает» — ручное списание № 32: онлайн, только после недозвона (оператору).
// Чего не хватает, написано над кнопкой подвала (те же тексты, что в шторке «Звонить»), а не молча серой кнопкой.
// Подписи колонки, причины и итога подставляются из настроек, в локалях их нет (§9.9).
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { BottomSheet, Button, Chip, ChipGroup, Field, Segmented, Textarea } from '@/ui/kit';
import { lprNeeded, missingFor, type Missing } from '@/ui/call/validate';
import type { CallConfig, OutcomeButton } from '@/ui/call/types';
import { groupTrash, trashDraft, type TrashChoice, type TrashGroup } from './moves';
import type { BoardCardDto } from './types';

export interface TrashPick {
  choice: TrashChoice;
  lpr: '' | 'yes' | 'no';
  note: string;
}

const idOf = (c: TrashChoice) => `${c.kind === 'outcome' ? c.outcomeKind : 'written_off'}:${c.reason}`;

export function TrashSheet({
  card,
  call,
  columnTitle,
  returnDays,
  quick,
  more,
  onPick,
  onClose,
}: {
  card: BoardCardDto;
  call: CallConfig;
  /** Подпись колонки «Мусор» из настроек: в заголовке и на кнопке. */
  columnTitle: string;
  /** Срок возврата «Не интересует» в днях (`calling.returnDays.not_interested`); нет — без числа. */
  returnDays: number | null;
  quick: readonly TrashChoice[];
  more: readonly TrashChoice[];
  onPick: (pick: TrashPick) => void;
  onClose: () => void;
}) {
  const t = useTranslations('board');
  const tc = useTranslations('call');
  const [showMore, setShowMore] = useState(false);
  const [chosen, setChosen] = useState<TrashChoice | null>(null);
  const [lpr, setLpr] = useState<'' | 'yes' | 'no'>('');
  const [note, setNote] = useState('');

  // «Полный отказ» помечает номер плитки; без рабочего номера итог сервер не примет (phone_required)
  const noPhone = (c: TrashChoice) => c.kind === 'outcome' && c.outcomeKind === 'do_not_call' && !card.phone;
  const list = showMore ? [...quick, ...more] : quick;
  const groups: TrashGroup[] = showMore ? groupTrash(more, call) : [];
  const def: OutcomeButton | null = chosen?.kind === 'outcome' ? (call.outcomes.find((o) => o.kind === chosen.outcomeKind) ?? null) : null;
  // Чего не хватает для итога: ЛПР, текст «Другое» (то же правило, что у шторки «Звонить»)
  const missingBase: Missing[] = def && chosen ? missingFor(def, trashDraft(def, chosen.reason, lpr, note, false), call) : [];
  const needsNote = chosen?.needsText === true;
  // Списание не спрашивает ЛПР и текста; «Другое» без заметки — «напишите пояснение»
  const missing: Missing[] = chosen === null ? ['reason'] : [...new Set<Missing>([...missingBase, ...(needsNote && note.trim() === '' && !missingBase.includes('reasonText') ? (['reasonText'] as Missing[]) : [])])];
  // «ЛПР: да/нет» видно сразу, если его требует хоть один итог списка; выбрано списание - не нужно
  const anyNeedsLpr = list.some((c) => {
    const d = c.kind === 'outcome' ? call.outcomes.find((o) => o.kind === c.outcomeKind) : undefined;
    return d !== undefined && lprNeeded(d, call);
  });
  const needsLpr = chosen ? def !== null && lprNeeded(def, call) : anyNeedsLpr;
  const lprMissing = chosen !== null && missing.includes('lpr');
  const ready = chosen !== null && !noPhone(chosen) && missing.length === 0 && !(chosen.kind === 'write_off' && chosen.blocked);

  const blockedWriteOff = list.find((c) => c.kind === 'write_off' && c.blocked === 'call_first');
  const noPhoneChoice = list.find(noPhone);
  const outcomeLabel = (kind: string) => call.outcomes.find((o) => o.kind === kind)?.label ?? '';

  const effectText = (g: TrashGroup): string => {
    if (g.id === 'not_interested') return returnDays !== null ? t('trash.group.effect.not_interestedDays', { days: returnDays }) : t('trash.group.effect.not_interested');
    if (g.id === 'not_target' || g.id === 'do_not_call' || g.id === 'written_off') return t(`trash.group.effect.${g.id}`);
    return '';
  };

  const chipOf = (c: TrashChoice) => (
    <Chip
      key={idOf(c)}
      active={chosen !== null && idOf(chosen) === idOf(c)}
      disabled={(c.kind === 'write_off' && c.blocked !== null) || noPhone(c)}
      onClick={() => setChosen(c)}
      data-testid={`trash-reason-${idOf(c).replace(':', '-')}`}
    >
      {c.label}
    </Chip>
  );

  return (
    <BottomSheet
      open
      onClose={onClose}
      closeLabel={t('sheet.close')}
      title={t('trash.title', { column: columnTitle })}
      description={card.name}
      footer={
        <div className="flex flex-col gap-2">
          {!ready && missing.length > 0 && (
            <ul className="text-sm" role="status" style={{ color: 'var(--text-2)' }} data-testid="trash-missing">
              {missing.map((m) => (
                <li key={m}>{tc(`sheet.missing.${m}`)}</li>
              ))}
            </ul>
          )}
          <Button size="lg" block disabled={!ready} onClick={() => chosen && onPick({ choice: chosen, lpr, note })} data-testid="trash-confirm">
            {t('trash.confirm', { column: columnTitle })}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4" data-testid="trash-sheet">
        {needsLpr && (
          <fieldset className="flex flex-col gap-2" data-testid="trash-lpr">
            <legend className="mb-2 text-sm font-semibold">{t('trash.lprQuestion')}</legend>
            <div className="rounded-[var(--radius-control)]" style={lprMissing ? { boxShadow: '0 0 0 2px var(--warning)' } : undefined} data-missing={lprMissing ? '1' : undefined}>
              <Segmented
                label={t('trash.lprQuestion')}
                className="w-full sm:max-w-56"
                items={[
                  { id: 'yes', label: t('trash.yes'), active: lpr === 'yes', testId: 'trash-lpr-yes' },
                  { id: 'no', label: t('trash.no'), active: lpr === 'no', testId: 'trash-lpr-no' },
                ]}
                onSelect={(id) => setLpr(lpr === id ? '' : (id as 'yes' | 'no'))}
              />
            </div>
          </fieldset>
        )}
        <ChipGroup label={t('trash.reasons')} className="flex-wrap">
          {quick.map(chipOf)}
          {more.length > 0 && !showMore && (
            <Chip onClick={() => setShowMore(true)} data-testid="trash-more">
              {t('trash.more')}
            </Chip>
          )}
        </ChipGroup>
        {groups.map((g) => (
          <section key={g.id} className="flex flex-col gap-2" data-testid={`trash-group-${g.id}`}>
            <h3 className="text-sm font-semibold">{g.outcomeLabel ?? t('trash.group.writtenOff')}</h3>
            <p className="text-sm" style={{ color: 'var(--text-2)' }}>
              {effectText(g)}
            </p>
            <ChipGroup label={g.outcomeLabel ?? t('trash.group.writtenOff')} className="flex-wrap">
              {g.items.map(chipOf)}
            </ChipGroup>
          </section>
        ))}
        {blockedWriteOff && (
          <p className="text-sm" style={{ color: 'var(--text-2)' }} data-testid="trash-call-first">
            {t('trash.callFirst', { reason: blockedWriteOff.label })}
          </p>
        )}
        {noPhoneChoice && (
          <p className="text-sm" style={{ color: 'var(--text-2)' }} data-testid="trash-no-phone">
            {t('trash.noPhone', { outcome: noPhoneChoice.kind === 'outcome' ? outcomeLabel(noPhoneChoice.outcomeKind) : '' })}
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
