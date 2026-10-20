'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Badge, Button, Card, EmptyState, ToastProvider, useToast } from '@/ui/kit';
import { call } from '../../bookings/api';
import { ConsultantSheet } from './ConsultantSheet';
import type { ConsultantView, Direction, Person } from './types';

interface Props {
  consultants: ConsultantView[];
  candidates: Person[];
  directions: Direction[];
  /** Флаг BK_WIZARD: у консультанта есть страница графика, вверху — «День консультаций». */
  withSchedule: boolean;
}

/** Консультанты: список, добавить, править, выключить (B5a); график и день консультаций — за флагом BK_WIZARD (B5b). */
export function ConsultantsBoard(props: Props) {
  return (
    <ToastProvider>
      <Board {...props} />
    </ToastProvider>
  );
}

function Board({ consultants: initial, candidates: initialCandidates, directions, withSchedule }: Props) {
  const t = useTranslations('booking.consultants');
  const te = useTranslations('booking.errors');
  const toast = useToast();
  const [list, setList] = useState(initial);
  const [candidates, setCandidates] = useState(initialCandidates);
  const [sheet, setSheet] = useState<{ open: boolean; consultant: ConsultantView | null }>({ open: false, consultant: null });
  const [problem, setProblem] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const labelOf = (key: string) => directions.find((d) => d.key === key)?.label ?? key;
  const upsert = (c: ConsultantView) => setList((cur) => (cur.some((x) => x.id === c.id) ? cur.map((x) => (x.id === c.id ? c : x)) : [...cur, c]).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name)));

  const toggle = async (c: ConsultantView) => {
    if (busyId) return;
    setBusyId(c.id);
    setProblem(null);
    const r = await call<ConsultantView>('PATCH', `/api/bookings/consultants/${encodeURIComponent(c.id)}`, { seenUpdatedAt: c.updatedAt, patch: { active: !c.active } });
    setBusyId(null);
    if (!r.ok) return setProblem(r.status === 409 && r.code === 'conflict' ? t('stale') : te.has(r.code) ? te(r.code) : te('conflict'));
    upsert(r.data);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => setSheet({ open: true, consultant: null })}>
          {t('add')}
        </Button>
        {withSchedule && (
          <Button href="/bookings/consult-day" variant="secondary">
            {t('dayLink')}
          </Button>
        )}
      </div>
      {problem && <Alert tone="danger">{problem}</Alert>}
      {list.length === 0 ? (
        <EmptyState title={t('empty')} />
      ) : (
        <ul className="flex flex-col gap-2">
          {list.map((c) => (
            <li key={c.id}>
              <Card as="article" data-testid="consultant-card">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="font-medium">{c.name}</div>
                    <div className="text-sm text-[var(--text-2)]">{c.directions.length > 0 ? c.directions.map(labelOf).join(', ') : t('anyDirection')}</div>
                    <div className="text-sm text-[var(--text-2)]">
                      {t('slotValue', { minutes: c.slotMin, capacity: c.capacity })} · {c.autoAssign ? t('autoOn') : t('autoOff')} · {c.usesSchedule ? t('schedule') : t('noSchedule')}
                    </div>
                  </div>
                  <Badge tone={c.active ? 'success' : 'neutral'}>{c.active ? t('active') : t('inactive')}</Badge>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button variant="secondary" size="sm" onClick={() => setSheet({ open: true, consultant: c })}>
                    {t('edit')}
                  </Button>
                  {withSchedule && (
                    <Button href={`/consultants/${encodeURIComponent(c.id)}`} variant="secondary" size="sm">
                      {t('scheduleLink')}
                    </Button>
                  )}
                  <Button variant="quiet" size="sm" disabled={busyId === c.id} onClick={() => void toggle(c)}>
                    {c.active ? t('deactivate') : t('activate')}
                  </Button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <ConsultantSheet
        open={sheet.open}
        consultant={sheet.consultant}
        candidates={candidates}
        directions={directions}
        onClose={() => setSheet({ open: false, consultant: null })}
        onSaved={(c, created) => {
          upsert(c);
          if (created) setCandidates((cur) => cur.filter((p) => p.userId !== c.userId));
          setSheet({ open: false, consultant: null });
          toast.show({ message: created ? t('created') : t('saved'), tone: 'success' });
        }}
      />
    </div>
  );
}
