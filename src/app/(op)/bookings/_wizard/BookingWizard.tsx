'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Button, Tabs, useToast } from '@/ui/kit';
import { toBookingBody, type WizardChoice } from './choice';
import { ConfirmStep } from './ConfirmStep';
import { ConsultStep } from './ConsultStep';
import { DoneStep } from './DoneStep';
import { formatWhen } from './format';
import { GroupStep } from './GroupStep';
import { cancelAsOperatorError, fetchOffer, fetchWizard, postBooking, type WizardAction, type WizardResult } from './result';
import type { BookingView, BookingWizardView } from './types';

export type WizardSubmit = (choice: WizardChoice, requestId: string) => Promise<WizardResult>;

export interface BookingWizardProps {
  view: BookingWizardView;
  /** Нет — путь B (`POST /api/bookings`). Шторка итога передаёт отправку итога с `agreement.booking`. */
  submit?: WizardSubmit;
  onDone?: (r: { booking: BookingView; action: WizardAction }) => void;
  /** Подбор консультанта в консультации (флаг BK_WIZARD, только путь B). Нет — заявка без консультанта. */
  consultStrip?: boolean;
}

interface Problem {
  code: string;
  /** Для «мест не осталось»: на какую дату не хватило. */
  when?: string;
}

const newKey = () => globalThis.crypto.randomUUID();
/** Эти ошибки означают, что список мероприятий устарел: перечитываем предложение. */
const STALE_EVENT = ['event_cancelled', 'event_in_past', 'already_registered'];
const STALE_SLOT = ['outside_hours', 'slot_in_past', 'request_reused'];

/** Мастер записи: вкладки по видам, выбор, подтверждение, результат. Ключ запроса живёт до успеха (D-205). */
export function BookingWizard({ view: initial, submit, onDone, consultStrip = false }: BookingWizardProps) {
  const t = useTranslations('booking.wizard');
  const te = useTranslations('booking.errors');
  const locale = useLocale();
  const toast = useToast();
  const [view, setView] = useState(initial);
  const [tab, setTab] = useState(initial.types[0]?.key ?? '');
  const [requestId, setRequestId] = useState(newKey);
  const [pending, setPending] = useState<WizardChoice | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [stripRefresh, setStripRefresh] = useState(0);
  const tc = useTranslations('booking.consult');

  if (view.mode === 'outcome_required') {
    return (
      <div className="flex flex-col gap-3">
        <Alert tone="warning" title={t('outcomeRequiredTitle')}>
          {t('outcomeRequiredText')}
        </Alert>
        <Button href={`/clients/${view.clientId}`} variant="primary" size="lg" block>
          {t('toClient')}
        </Button>
      </div>
    );
  }
  if (done !== null) return <DoneStep clientId={view.clientId} text={done} />;

  const refreshWizard = async () => {
    const next = await fetchWizard(view.cardId);
    if (next) setView(next);
  };
  const refreshOffer = async (typeKey: string) => {
    const offer = await fetchOffer(view.clientId, typeKey);
    if (offer) setView((v) => ({ ...v, groupOffers: v.groupOffers.map((g) => (g.eventTypeKey === typeKey ? { ...g, ...offer } : g)) }));
  };

  const succeed = (r: Extract<WizardResult, { ok: true }>, choice: WizardChoice) => {
    const type = view.types.find((x) => x.key === choice.eventTypeKey);
    const when = formatWhen(r.booking.bookingDate, r.booking.startTime, locale);
    const args = { type: type?.short ?? choice.eventTypeKey, when };
    const consultant = choice.kind === 'individual' ? choice.consultant : undefined;
    const text = consultant
      ? tc(consultant.reserve ? 'doneReserve' : 'done', { ...args, consultant: consultant.name })
      : choice.kind === 'individual'
        ? t('doneRequest', args)
        : t(r.action === 'moved' ? 'doneMoved' : 'doneCreated', args);
    setDone(text);
    setPending(null);
    setRequestId(newKey());
    toast.show({
      message: text,
      tone: 'success',
      undo: {
        label: t('undo'),
        onUndo: () => {
          void cancelAsOperatorError(r.booking).then(async (ok) => {
            toast.show(ok ? { message: t('undone') } : { message: t('undoFailed'), tone: 'danger' });
            if (!ok) return;
            setDone(null);
            await refreshWizard();
          });
        },
      },
    });
    onDone?.({ booking: r.booking, action: r.action });
  };

  const fail = async (r: Extract<WizardResult, { ok: false }>, choice: WizardChoice) => {
    if (r.code === 'handled') return;
    if (r.code === 'event_full' && choice.kind === 'group') {
      // Последнее место заняли: показываем даты из ответа сервера, ключ запроса прежний
      setView((v) => ({ ...v, groupOffers: v.groupOffers.map((g) => (g.eventTypeKey === choice.eventTypeKey ? { ...g, options: 'alternatives' in r ? r.alternatives : [] } : g)) }));
      setProblem({ code: 'event_full', when: formatWhen(choice.event.eventDate, choice.event.startTime, locale) });
      setPending(null);
      setExpanded(true);
      return;
    }
    if (r.code === 'network') return setProblem({ code: 'network' });
    setProblem({ code: r.code });
    setPending(null);
    if (r.code === 'outcome_required') return setView((v) => ({ ...v, mode: 'outcome_required' }));
    if (STALE_EVENT.includes(r.code)) await refreshOffer(choice.eventTypeKey);
    if (STALE_SLOT.includes(r.code)) await refreshWizard();
    // Место заняли или пул заполнен: полоса подбора перечитывается, ключ запроса прежний (повтор безопасен)
    if (r.code === 'slot_taken' || r.code === 'pool_full') setStripRefresh((n) => n + 1);
    if (r.code === 'request_reused') setRequestId(newKey());
  };

  const confirm = async () => {
    if (!pending || busy) return;
    setBusy(true);
    setProblem(null);
    const send = submit ?? ((c, id) => postBooking(toBookingBody(view, c, id)));
    const r = await send(pending, requestId);
    setBusy(false);
    if (r.ok) succeed(r, pending);
    else await fail(r, pending);
  };

  const pick = (choice: WizardChoice) => {
    setProblem(null);
    setPending(choice);
  };

  const alert = problem && (
    <Alert tone={problem.code === 'network' ? 'warning' : 'danger'}>
      {problem.code === 'network' ? t('network') : problem.code === 'event_full' ? t('full', { when: problem.when ?? '' }) : te.has(problem.code) ? te(problem.code) : te('conflict')}
      {problem.code === 'network' && pending && (
        <Button variant="secondary" size="sm" className="ml-2" disabled={busy} onClick={() => void confirm()}>
          {t('retry')}
        </Button>
      )}
    </Alert>
  );

  if (pending) {
    const consult = pending.kind === 'individual' ? view.consultOffers.find((o) => o.eventTypeKey === pending.eventTypeKey) : undefined;
    const group = pending.kind === 'group' ? view.groupOffers.find((o) => o.eventTypeKey === pending.eventTypeKey) : undefined;
    return (
      <div className="flex flex-col gap-3">
        {alert}
        <ConfirmStep
          clientName={view.clientName}
          type={view.types.find((x) => x.key === pending.eventTypeKey)}
          choice={pending}
          current={(consult ?? group)?.current ?? null}
          directionLabel={pending.kind === 'individual' ? (consult?.directions.find((d) => d.key === pending.directionKey)?.label ?? '') : ''}
          busy={busy}
          onConfirm={() => void confirm()}
          onBack={() => setPending(null)}
        />
      </div>
    );
  }

  const panel = (key: string) =>
    view.types.find((x) => x.key === key)?.behavior === 'group' ? (
      <GroupStep offer={view.groupOffers.find((o) => o.eventTypeKey === key)} expanded={expanded} onPick={(event) => pick({ kind: 'group', eventTypeKey: key, event })} />
    ) : (
      <ConsultStep
        offer={view.consultOffers.find((o) => o.eventTypeKey === key)}
        onPick={pick}
        {...(consultStrip ? { strip: { cardId: view.cardId, refreshKey: stripRefresh } } : {})}
      />
    );

  return (
    <div className="flex flex-col gap-3">
      {alert}
      {view.types.length > 1 ? (
        <Tabs
          label={t('tabsLabel')}
          value={tab}
          onChange={(id) => {
            setTab(id);
            setProblem(null);
          }}
          items={view.types.map((x) => ({ id: x.key, label: x.short || x.label, content: x.key === tab ? panel(x.key) : null }))}
        />
      ) : (
        view.types[0] && (
          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold">{view.types[0].label}</h2>
            {panel(view.types[0].key)}
          </section>
        )
      )}
    </div>
  );
}
