'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, BottomSheet, Button, Checkbox } from '@/ui/kit';
import { call } from '../../api';
import type { EventBoardItem, Person } from './types';

interface Props {
  event: EventBoardItem | null;
  candidates: Person[];
  onClose: () => void;
  onSaved: (eventId: string, duty: Person[]) => void;
}

/** Выбор дежурных мероприятия: галочки по активным сотрудникам, сохранение целиком (`PUT /api/events/[id]/duty`). */
export function DutySheet({ event, candidates, onClose, onSaved }: Props) {
  const t = useTranslations('booking.events');
  const te = useTranslations('booking.errors');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [seen, setSeen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Лист открывается на другом мероприятии — выбор начинается с его текущих дежурных
  if (event && seen !== event.id) {
    setSeen(event.id);
    setPicked(new Set(event.duty.map((d) => d.userId)));
    setError(null);
  }

  const save = async () => {
    if (!event || busy) return;
    setBusy(true);
    setError(null);
    const userIds = [...picked];
    const r = await call<{ userIds: string[] }>('PUT', `/api/events/${encodeURIComponent(event.id)}/duty`, { userIds });
    setBusy(false);
    if (!r.ok) return setError(te.has(r.code) ? te(r.code) : te('conflict'));
    onSaved(event.id, candidates.filter((c) => r.data.userIds.includes(c.userId)));
  };

  return (
    <BottomSheet
      open={event !== null}
      onClose={onClose}
      title={t('setDuty')}
      closeLabel={t('close')}
      description={t('dutyHint')}
      footer={
        <Button variant="primary" size="lg" block disabled={busy} onClick={() => void save()}>
          {t('save')}
        </Button>
      }
    >
      <div className="flex flex-col gap-2">
        {error && <Alert tone="danger">{error}</Alert>}
        {candidates.map((c) => (
          <Checkbox
            key={c.userId}
            name={`duty-${c.userId}`}
            label={c.name}
            checked={picked.has(c.userId)}
            onChange={(e) =>
              setPicked((prev) => {
                const next = new Set(prev);
                if (e.target.checked) next.add(c.userId);
                else next.delete(c.userId);
                return next;
              })
            }
          />
        ))}
      </div>
    </BottomSheet>
  );
}
