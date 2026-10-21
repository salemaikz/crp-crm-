'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, BottomSheet, Button, Card, Field, Input, Select, Textarea, ToastProvider, useToast } from '@/ui/kit';
import { call, newKey } from '@/app/(mgr)/bookings/api';

interface Props {
  dealId: string;
  cardId: string;
  version: number;
  can: { purchase: boolean; editStage: boolean; moveBack: boolean; lose: boolean; editPurchase: boolean };
  amountKzt: number;
  wonDay: string | null;
  /** Открытые этапы, кроме текущего; `back` — назад по воронке. */
  stages: { key: string; label: string; back: boolean; nextTask: boolean }[];
  reasons: { key: string; label: string; needsText: boolean }[];
}

type Sheet = 'move' | 'lose' | 'edit' | 'cancel' | null;

const DAY_MS = 86_400_000;
const WHEN = [
  { key: 'whenTomorrow', days: 1 },
  { key: 'when2', days: 2 },
  { key: 'when3', days: 3 },
  { key: 'whenWeek', days: 7 },
] as const;

const digitsOf = (s: string): string => s.replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 13);
const grouped = (d: string): string => (d === '' ? '' : new Intl.NumberFormat('ru-RU').format(Number(d)));

export function DealActions(props: Props) {
  return (
    <ToastProvider>
      <Actions {...props} />
    </ToastProvider>
  );
}

// Действия со сделкой (B6, §5.9): кнопки по `can`, листы снизу на телефоне. Ключ действия живёт до успеха
// (повтор после обрыва безопасен); 409 «изменилось» — новый ключ и обновление страницы.
function Actions({ dealId, cardId, version, can, amountKzt, wonDay, stages, reasons }: Props) {
  const t = useTranslations('deals');
  const router = useRouter();
  const toast = useToast();
  const [sheet, setSheet] = useState<Sheet>(null);
  const [opId, setOpId] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // поля листов
  const [stageKey, setStageKey] = useState('');
  const [step, setStep] = useState<'call' | 'meeting'>('call');
  const [days, setDays] = useState('1');
  const [reason, setReason] = useState('');
  const [text, setText] = useState('');
  const [amount, setAmount] = useState(String(amountKzt));
  const [day, setDay] = useState(wonDay ?? '');
  const [mode, setMode] = useState<'refund' | 'error'>('refund');
  const [comment, setComment] = useState('');

  const open = (s: Sheet) => {
    setError(null);
    setSheet(s);
  };
  const problem = (code: string) => setError(t.has(`errors.${code}`) ? t(`errors.${code}`) : t('errors.conflict'));

  const send = async (method: 'POST' | 'PATCH', path: string, body: Record<string, unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await call(method, `/api/deals/${encodeURIComponent(dealId)}/${path}`, { opId, version, ...body });
    setBusy(false);
    if (!r.ok) {
      if (r.status === 409) setOpId(newKey());
      return problem(r.code);
    }
    setOpId(newKey());
    setSheet(null);
    toast.show({ message: t('actions.saved'), tone: 'success' });
    router.refresh();
  };

  const target = stages.find((s) => s.key === stageKey);
  const visibleStages = stages.filter((s) => !s.back || can.moveBack);
  const chosenReason = reasons.find((r) => r.key === reason);
  const any = can.purchase || can.editStage || can.lose || can.editPurchase;
  if (!any) return null;

  return (
    <Card as="section" data-testid="deal-actions">
      <div className="flex flex-wrap gap-2">
        {can.purchase && (
          <Button href={`/deals/purchase/${encodeURIComponent(cardId)}`} variant="primary">
            {t('actions.purchase')}
          </Button>
        )}
        {can.editStage && visibleStages.length > 0 && (
          <Button variant="secondary" onClick={() => open('move')}>
            {t('actions.move')}
          </Button>
        )}
        {can.lose && (
          <Button variant="secondary" onClick={() => open('lose')}>
            {t('actions.lose')}
          </Button>
        )}
        {can.editPurchase && (
          <>
            <Button variant="secondary" onClick={() => open('edit')}>
              {t('actions.editAmount')}
            </Button>
            <Button variant="secondary" onClick={() => open('cancel')}>
              {t('actions.cancel')}
            </Button>
          </>
        )}
      </div>

      <BottomSheet
        open={sheet === 'move'}
        onClose={() => setSheet(null)}
        title={t('actions.move')}
        closeLabel={t('actions.close')}
        footer={
          <Button
            variant="primary"
            block
            disabled={busy || !target}
            onClick={() => void send('POST', 'stage', { stageKey, nextStep: target?.nextTask ? { dueAt: Date.now() + Number(days) * DAY_MS, kind: step } : null })}
          >
            {t('actions.confirm')}
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          {error && <Alert tone="danger">{error}</Alert>}
          <div className="flex flex-col gap-2" role="radiogroup" aria-label={t('actions.move')}>
            {visibleStages.map((s) => (
              <Button key={s.key} variant={stageKey === s.key ? 'primary' : 'secondary'} block aria-pressed={stageKey === s.key} onClick={() => setStageKey(s.key)}>
                {s.back ? `${s.label} (${t('actions.back')})` : s.label}
              </Button>
            ))}
          </div>
          {target?.nextTask && (
            <>
              <Field label={t('actions.nextStep')}>
                <Select name="deal-step" value={step} onChange={(e) => setStep(e.target.value === 'meeting' ? 'meeting' : 'call')}>
                  <option value="call">{t('actions.stepCall')}</option>
                  <option value="meeting">{t('actions.stepMeeting')}</option>
                </Select>
              </Field>
              <Field label={t('actions.stepWhen')}>
                <Select name="deal-step-when" value={days} onChange={(e) => setDays(e.target.value)}>
                  {WHEN.map((w) => (
                    <option key={w.key} value={w.days}>
                      {t(`actions.${w.key}`)}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          )}
        </div>
      </BottomSheet>

      <BottomSheet
        open={sheet === 'lose'}
        onClose={() => setSheet(null)}
        title={t('actions.lose')}
        closeLabel={t('actions.close')}
        footer={
          <Button variant="primary" block disabled={busy || !chosenReason} onClick={() => void send('POST', 'lose', { reasonCode: reason, reasonText: chosenReason?.needsText ? text : '' })}>
            {t('actions.confirm')}
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label={t('actions.reason')}>
            <Select name="deal-lose-reason" value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="" />
              {reasons.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </Select>
          </Field>
          {chosenReason?.needsText && (
            <Field label={t('actions.reasonText')}>
              <Textarea name="deal-lose-text" rows={3} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} />
            </Field>
          )}
        </div>
      </BottomSheet>

      <BottomSheet
        open={sheet === 'edit'}
        onClose={() => setSheet(null)}
        title={t('actions.editAmount')}
        closeLabel={t('actions.close')}
        footer={
          <Button
            variant="primary"
            block
            disabled={busy || amount === ''}
            onClick={() => void send('PATCH', 'purchase', { amountKzt: Number(amount), ...(day !== '' ? { wonDay: day } : {}) })}
          >
            {t('actions.save')}
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label={t('purchase.amount')}>
            <Input name="deal-edit-amount" inputMode="numeric" autoComplete="off" value={grouped(amount)} onChange={(e) => setAmount(digitsOf(e.target.value))} />
          </Field>
          <Field label={t('purchase.date')}>
            <Input name="deal-edit-date" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
          </Field>
        </div>
      </BottomSheet>

      <BottomSheet
        open={sheet === 'cancel'}
        onClose={() => setSheet(null)}
        title={t('actions.cancel')}
        closeLabel={t('actions.close')}
        footer={
          <Button variant="primary" block disabled={busy || comment.trim() === ''} onClick={() => void send('POST', 'cancel-purchase', { mode, comment })}>
            {t('actions.confirm')}
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          {error && <Alert tone="danger">{error}</Alert>}
          <div className="grid grid-cols-2 gap-2">
            <Button variant={mode === 'refund' ? 'primary' : 'secondary'} aria-pressed={mode === 'refund'} onClick={() => setMode('refund')}>
              {t('actions.refund')}
            </Button>
            <Button variant={mode === 'error' ? 'primary' : 'secondary'} aria-pressed={mode === 'error'} onClick={() => setMode('error')}>
              {t('actions.inputError')}
            </Button>
          </div>
          <Field label={t('actions.comment')}>
            <Textarea name="deal-cancel-comment" rows={3} maxLength={500} value={comment} onChange={(e) => setComment(e.target.value)} />
          </Field>
        </div>
      </BottomSheet>
    </Card>
  );
}
