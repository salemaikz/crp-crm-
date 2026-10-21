'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { call, newKey } from '@/app/(mgr)/bookings/api';
import { Alert, BottomSheet, Button, Card, Field, Textarea, ToastProvider, useToast } from '@/ui/kit';

interface Props {
  handoffId: string;
  can: { accept: boolean; decline: boolean; assign: boolean };
}

type Sheet = 'assign' | 'decline' | null;
type Member = { userId: string; name: string };

export function HandoffActions(props: Props) {
  return (
    <ToastProvider>
      <Actions {...props} />
    </ToastProvider>
  );
}

// Действия главы отдела (B6b, §7.4): «Принять» сразу, «Назначить исполнителя» и «Отклонить» — листом снизу.
// Ключ действия живёт до успеха (повтор после обрыва безопасен); 409 — новый ключ и обновление страницы.
function Actions({ handoffId, can }: Props) {
  const t = useTranslations('handoffs');
  const router = useRouter();
  const toast = useToast();
  const [sheet, setSheet] = useState<Sheet>(null);
  const [opId, setOpId] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [members, setMembers] = useState<Member[] | null>(null);

  const url = (path: string) => `/api/handoffs/${encodeURIComponent(handoffId)}/${path}`;
  const problem = (code: string) => setError(t.has(`errors.${code}`) ? t(`errors.${code}`) : t('errors.conflict'));

  useEffect(() => {
    if (sheet !== 'assign' || members !== null) return;
    void call<{ items: Member[] }>('GET', url('members')).then((r) => {
      if (r.ok) setMembers(r.data.items);
      else problem(r.code);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet]);

  const send = async (path: string, body: Record<string, unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await call('POST', url(path), { opId, ...body });
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

  if (!can.accept && !can.assign) return <p className="text-sm text-[var(--text-2)]">{t('page.readOnly')}</p>;

  return (
    <Card as="section" data-testid="handoff-actions">
      <div className="flex flex-col gap-2">
        {can.accept && (
          <Button variant="primary" block disabled={busy} onClick={() => void send('accept', {})}>
            {t('accept')}
          </Button>
        )}
        {can.assign && (
          <Button variant="secondary" block onClick={() => { setError(null); setSheet('assign'); }}>
            {t('assign')}
          </Button>
        )}
        {can.decline && (
          <Button variant="secondary" block onClick={() => { setError(null); setSheet('decline'); }}>
            {t('decline')}
          </Button>
        )}
      </div>
      {error && sheet === null && <Alert tone="danger">{error}</Alert>}

      <BottomSheet open={sheet === 'assign'} onClose={() => setSheet(null)} title={t('assign')} closeLabel={t('actions.close')}>
        <div className="flex flex-col gap-2">
          {error && <Alert tone="danger">{error}</Alert>}
          {members !== null && members.length === 0 && <p className="text-sm text-[var(--text-2)]">{t('actions.noMembers')}</p>}
          {(members ?? []).map((m) => (
            <Button key={m.userId} variant="secondary" block disabled={busy} onClick={() => void send('assign', { userId: m.userId })}>
              {m.name}
            </Button>
          ))}
        </div>
      </BottomSheet>

      <BottomSheet
        open={sheet === 'decline'}
        onClose={() => setSheet(null)}
        title={t('decline')}
        closeLabel={t('actions.close')}
        footer={
          <Button variant="primary" block disabled={busy || reason.trim() === ''} onClick={() => void send('decline', { reason })}>
            {t('actions.confirm')}
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label={t('declineReason')}>
            <Textarea name="handoff-decline-reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </div>
      </BottomSheet>
    </Card>
  );
}
