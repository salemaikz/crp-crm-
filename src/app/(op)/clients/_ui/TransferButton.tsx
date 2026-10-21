'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { Alert, Button, Field, Modal, Select, useToast } from '@/ui/kit';

type Staff = { userId: string; name: string; active: boolean };
type Props = { cardId: string; version: number; ownerUserId: string | null };

/**
 * «Передать…» из карточки клиента (B9a, D-254): выбор активного сотрудника, подтверждение с числом связанных
 * карточек-двойников. Версия карточки уходит с запросом: устаревшая — 409 `card_changed`.
 */
export function TransferButton({ cardId, version, ownerUserId }: Props) {
  const t = useTranslations('clients');
  const te = useTranslations('clients.transfer.errors');
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [staff, setStaff] = useState<Staff[] | null>(null);
  const [related, setRelated] = useState(0);
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const opId = useRef<string>(crypto.randomUUID());

  async function show() {
    setOpen(true);
    setError(null);
    setTo('');
    setStaff(null);
    const res = await fetch(`/api/team/transfers/staff?cardId=${encodeURIComponent(cardId)}`).catch(() => null);
    const data = (await res?.json().catch(() => null)) as { items?: Staff[]; related?: number } | null;
    if (!res?.ok || !data) return setError('generic');
    setStaff((data.items ?? []).filter((s) => s.active && s.userId !== ownerUserId));
    setRelated(data.related ?? 0);
  }

  async function submit() {
    if (busy || !to) return;
    setBusy(true);
    setError(null);
    const res = await fetch('/api/team/transfers/one', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ opId: opId.current, cardId, version, toUserId: to }),
    }).catch(() => null);
    const data = (await res?.json().catch(() => null)) as { moved?: number; detail?: string; error?: string } | null;
    setBusy(false);
    if (res?.ok && data) {
      opId.current = crypto.randomUUID();
      setOpen(false);
      toast.show({ message: t('transfer.done', { moved: data.moved ?? 1 }), tone: 'success' });
      router.refresh();
      return;
    }
    if (!res) return setError('network');
    opId.current = crypto.randomUUID(); // сервер ответил отказом: новая попытка — новая операция
    if (data?.detail === 'card_changed') router.refresh();
    setError(data?.detail ?? (res.status === 423 ? 'read_only' : res.status === 404 || res.status === 403 ? 'not_found' : 'generic'));
  }

  return (
    <>
      <Button variant="quiet" onClick={() => void show()}>
        {t('transfer.open')}
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title={t('transfer.title')} closeLabel={t('form.close')}>
        <div className="flex flex-col gap-3">
          {error && <Alert tone="danger">{te(error as 'generic')}</Alert>}
          {staff !== null && staff.length === 0 && <p>{t('transfer.noRecipients')}</p>}
          {staff !== null && staff.length > 0 && (
            <Field label={t('transfer.recipient')}>
              <Select name="transfer-recipient" value={to} onChange={(e) => setTo(e.target.value)}>
                <option value="">{t('transfer.choose')}</option>
                {staff.map((s) => (
                  <option key={s.userId} value={s.userId}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {related > 0 && <p className="text-sm text-[var(--text-2)]">{t('transfer.related', { count: related })}</p>}
          <div className="flex gap-2">
            <Button variant="primary" disabled={busy || !to} onClick={() => void submit()}>
              {t('transfer.confirm')}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t('form.cancel')}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
