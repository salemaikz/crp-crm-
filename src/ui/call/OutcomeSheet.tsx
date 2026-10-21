'use client';

// Шторка итога звонка (PROCESS 3.2): два переключателя «ЛПР» и «Целевой», семь кнопок итогов из настроек,
// под выбранным итогом — только обязательные для него поля. Итог без обязательных полей ставится одним нажатием.
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { ArrowLeft, Check } from 'lucide-react';
import { BottomSheet, Button, Checkbox, Chip, ChipGroup, Field, Input, Segmented, Select, Textarea } from '@/ui/kit';
import type { BookingWizardProps } from '@/app/(op)/bookings/_wizard/BookingWizard';
import { BookingPanel } from './BookingPanel';
import { resolvePreset } from './callback';
import { missingFor, oneTap, type Missing } from './validate';
import type { PendingState } from './pending';
import type { CallConfig, OutcomeButton, SheetDraft } from './types';
import { fromInputValue, toInputValue } from './zoned';

export interface SheetPhone {
  id: string;
  label: string;
}

type Props = {
  config: CallConfig;
  pending: PendingState;
  phones: SheetPhone[];
  onChange: (patch: Partial<SheetDraft>) => void;
  onClose: () => void;
  onSubmit: (def: OutcomeButton, fieldValues: Record<string, string>) => void;
  /** Есть ли у клиента контакт ЛПР: он уходит в `agreement.contactId`. */
  hasContact: boolean;
  /** Мастер записи открыт внутри шторки (состояние держит экран: отказ сервера возвращает к форме). */
  booking: boolean;
  onBookingOpen: (def: OutcomeButton, fieldValues: Record<string, string>) => void;
  onBookingBack: () => void;
  /** «Запишу позже»: итог «Договорились» без записи, с задачей. */
  onLater: (def: OutcomeButton, fieldValues: Record<string, string>) => void;
  submitBooking: NonNullable<BookingWizardProps['submit']>;
  onBooked: NonNullable<BookingWizardProps['onDone']>;
};

export function OutcomeSheet({ config, pending, phones, onChange, onClose, onSubmit, hasContact, booking, onBookingOpen, onBookingBack, onLater, submitBooking, onBooked }: Props) {
  const t = useTranslations('call');
  const f = useFormatter();
  const d = pending.draft;
  const [openedAt] = useState(() => Date.now());
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [presetIdx, setPresetIdx] = useState<number | 'custom' | null>(d.callbackAt !== null ? 'custom' : null);

  const selected = config.outcomes.find((o) => o.key === d.outcomeKey) ?? null;
  const missing: Missing[] = selected ? missingFor(selected, d, config, fieldValues, hasContact) : [];

  const choose = (def: OutcomeButton) => {
    if (oneTap(def, d, config)) return onSubmit(def, {});
    if (def.key !== d.outcomeKey) {
      onChange({ outcomeKey: def.key, reasonCode: '', callbackAt: null, alsoDncPhoneIds: [], phoneId: d.phoneId ?? phones[0]?.id ?? null });
      setPresetIdx(null);
    }
  };

  const presetLabel = (i: number) => {
    const p = config.callbackPresets[i];
    if (!p) return '';
    if (p.kind === 'plus') return p.minutes % 60 === 0 ? t('presets.hours', { n: p.minutes / 60 }) : t('presets.minutes', { n: p.minutes });
    const r = resolvePreset(p, openedAt, config.timeZone, config.calendar);
    return r.shape === 'tomorrow' ? t('presets.tomorrow', { time: p.time }) : t('presets.day', { day: f.dateTime(r.at, { weekday: 'short' }), time: p.time });
  };

  const hint = (m: Missing): string => t(`sheet.missing.${m}`);

  return (
    <BottomSheet
      open
      onClose={onClose}
      closeLabel={t('sheet.close')}
      title={booking ? t('booking.title') : t('sheet.title')}
      description={`${pending.call.title} · ${pending.call.phoneMasked}`}
      back={
        booking && selected ? (
          <Button variant="quiet" size="sm" flush onClick={onBookingBack} data-testid="booking-back">
            <ArrowLeft aria-hidden="true" />
            {t('sheet.back')}
          </Button>
        ) : undefined
      }
      footer={
        selected &&
        !booking &&
        (selected.kind === 'agreed' ? (
          <div className="flex flex-col gap-2">
            <Button size="lg" block disabled={missing.length > 0} onClick={() => onBookingOpen(selected, fieldValues)} data-testid="sheet-book">
              {t('sheet.book')}
            </Button>
            <Button variant="secondary" block disabled={missing.length > 0} onClick={() => onLater(selected, fieldValues)} data-testid="sheet-later">
              {t('sheet.later')}
            </Button>
          </div>
        ) : (
          <Button size="lg" block disabled={missing.length > 0} onClick={() => onSubmit(selected, fieldValues)} data-testid="sheet-save">
            {t('sheet.save')}
          </Button>
        ))
      }
    >
      {booking && selected ? (
        <BookingPanel
          cardId={pending.call.cardId}
          submit={submitBooking}
          onDone={onBooked}
          onLater={() => onLater(selected, fieldValues)}
        />
      ) : (
        <div className="flex flex-col gap-4" data-testid="outcome-sheet">
          {/* ЛПР «Да / Нет» — две равные доли; «Целевой» — отдельный флажок-чип справа */}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <span className="text-sm font-semibold">{t('sheet.lpr')}</span>
              <Segmented
                label={t('sheet.lprLabel')}
                className="min-w-0 flex-1 sm:max-w-56"
                items={[
                  { id: 'yes', label: t('sheet.yes'), active: d.lpr === 'yes', testId: 'lpr-yes' },
                  { id: 'no', label: t('sheet.no'), active: d.lpr === 'no', testId: 'lpr-no' },
                ]}
                onSelect={(id) => onChange({ lpr: d.lpr === id ? '' : (id as 'yes' | 'no') })}
              />
            </div>
            <Chip active={d.target} onClick={() => onChange({ target: !d.target })} data-testid="target-chip">
              {t('sheet.target')}
            </Chip>
          </div>
          {selected && missing.includes('lpr') && (
            <p className="text-sm" role="status" style={{ color: 'var(--warning)' }}>
              {hint('lpr')}
            </p>
          )}

          <div className="grid grid-cols-2 gap-2 [&>*:last-child:nth-child(odd)]:col-span-2" role="group" aria-label={t('sheet.outcomes')}>
            {config.outcomes.map((o) => (
              <button
                key={o.key}
                type="button"
                className="k-btn k-btn--secondary text-left aria-pressed:border-[var(--ring)] aria-pressed:shadow-[inset_0_0_0_1px_var(--ring)]"
                style={{ borderLeft: `6px solid ${o.color}`, justifyContent: 'space-between' }}
                aria-pressed={o.key === d.outcomeKey}
                data-testid={`outcome-${o.kind}`}
                data-outcome={o.key}
                onClick={() => choose(o)}
              >
                <span>{o.label}</span>
                {o.key === d.outcomeKey && <Check aria-hidden="true" />}
              </button>
            ))}
          </div>

          {selected && (
            <div className="flex flex-col gap-3" data-testid="outcome-details">
              {selected.reasons.length > 0 && (
                <ChipGroup label={t('sheet.reason')} className="flex-wrap">
                  {selected.reasons.map((r) => (
                    <Chip key={r.key} active={d.reasonCode === r.key} onClick={() => onChange({ reasonCode: r.key })}>
                      {r.label}
                    </Chip>
                  ))}
                </ChipGroup>
              )}

              {(selected.kind === 'callback' || selected.requires.callbackAt) && (
                <div className="flex flex-col gap-2">
                  <ChipGroup label={t('sheet.callbackAt')} className="flex-wrap">
                    {config.callbackPresets.map((p, i) => (
                      <Chip
                        key={`${p.kind}-${i}`}
                        active={presetIdx === i}
                        onClick={() => {
                          setPresetIdx(i);
                          onChange({ callbackAt: resolvePreset(p, Date.now(), config.timeZone, config.calendar).at });
                        }}
                      >
                        {presetLabel(i)}
                      </Chip>
                    ))}
                    <Chip active={presetIdx === 'custom'} onClick={() => setPresetIdx('custom')}>
                      {t('presets.other')}
                    </Chip>
                  </ChipGroup>
                  {presetIdx === 'custom' && (
                    <Field label={t('sheet.callbackAtLabel')}>
                      <Input
                        type="datetime-local"
                        value={d.callbackAt === null ? '' : toInputValue(d.callbackAt, config.timeZone)}
                        onChange={(e) => onChange({ callbackAt: fromInputValue(e.target.value, config.timeZone) })}
                      />
                    </Field>
                  )}
                </div>
              )}

              {d.lpr === 'no' && config.lprNoRequiresInfo && (
                <fieldset className="flex flex-col gap-2">
                  <legend className="text-sm font-semibold">{t('sheet.lprInfo')}</legend>
                  <Field label={t('sheet.lprName')} optionalLabel={t('sheet.optional')}>
                    <Input value={d.lprName} maxLength={200} onChange={(e) => onChange({ lprName: e.target.value })} />
                  </Field>
                  <Field label={t('sheet.lprPhone')} optionalLabel={t('sheet.optional')}>
                    <Input type="tel" inputMode="tel" value={d.lprPhone} maxLength={200} onChange={(e) => onChange({ lprPhone: e.target.value })} />
                  </Field>
                  <Field label={t('sheet.lprWhen')} optionalLabel={t('sheet.optional')}>
                    <Input value={d.lprWhen} maxLength={200} onChange={(e) => onChange({ lprWhen: e.target.value })} />
                  </Field>
                  <p className="text-sm" style={{ color: 'var(--text-3)' }}>
                    {t('sheet.lprInfoHint')}
                  </p>
                </fieldset>
              )}

              {(selected.kind === 'bad_number' || selected.kind === 'do_not_call') && phones.length > 0 && (
                <Field label={t('sheet.phone')}>
                  <Select value={d.phoneId ?? ''} onChange={(e) => onChange({ phoneId: e.target.value || null })}>
                    {phones.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}

              {selected.kind === 'do_not_call' && phones.length > 1 && (
                <fieldset className="flex flex-col gap-1">
                  <legend className="text-sm font-semibold">{t('sheet.alsoDnc')}</legend>
                  {phones
                    .filter((p) => p.id !== d.phoneId)
                    .map((p) => (
                      <Checkbox
                        key={p.id}
                        label={p.label}
                        checked={d.alsoDncPhoneIds.includes(p.id)}
                        onChange={(e) =>
                          onChange({ alsoDncPhoneIds: e.target.checked ? [...d.alsoDncPhoneIds, p.id] : d.alsoDncPhoneIds.filter((x) => x !== p.id) })
                        }
                      />
                    ))}
                </fieldset>
              )}

              {selected.requires.fields.map((key) => {
                const def = config.outcomeFields[key];
                if (!def) return null;
                return (
                  <Field key={key} label={def.label}>
                    {def.type === 'select' ? (
                      <Select value={fieldValues[key] ?? ''} onChange={(e) => setFieldValues({ ...fieldValues, [key]: e.target.value })}>
                        <option value="">{t('sheet.choose')}</option>
                        {def.options.map((o) => (
                          <option key={o.key} value={o.key}>
                            {o.label}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <Input value={fieldValues[key] ?? ''} maxLength={200} onChange={(e) => setFieldValues({ ...fieldValues, [key]: e.target.value })} />
                    )}
                  </Field>
                );
              })}

              <Field label={t('sheet.note')} optionalLabel={t('sheet.optional')}>
                <Textarea rows={2} maxLength={2000} value={d.note} onChange={(e) => onChange({ note: e.target.value })} />
              </Field>

              {missing.length > 0 && (
                <ul className="text-sm" role="status" style={{ color: 'var(--text-2)' }}>
                  {[...new Set(missing)].filter((m) => m !== 'lpr').map((m) => (
                    <li key={m}>{hint(m)}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </BottomSheet>
  );
}

