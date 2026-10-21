'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, BottomSheet, Button, Field, Input } from '@/ui/kit';
import { newKey, postWalkIn } from './api';

interface Props {
  open: boolean;
  eventId: string;
  onClose: () => void;
  /** Ответ сервера: тост и перечитывание списка делает родитель. */
  onDone: (answer: 'found' | 'new' | 'recorded') => void;
}

/**
 * Лист «Гость без записи»: номер, имя, компания. Ключ попытки создаётся при открытии и живёт до успеха
 * (D-205): повторное нажатие после обрыва не создаёт второго гостя.
 */
export function WalkInSheet({ open, eventId, onClose, onDone }: Props) {
  const t = useTranslations('booking.walkIn');
  const te = useTranslations('booking.errors');
  const td = useTranslations('booking.duty');
  const [requestId, setRequestId] = useState(newKey);
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await postWalkIn(eventId, { requestId, phone: phone.trim(), name: name.trim(), company: company.trim() });
    setBusy(false);
    if (!r.ok) {
      // 400 без кода домена — плохой номер или имя; остальное показываем по коду
      const key = r.code === 'bad_request' ? 'phone_invalid' : r.code;
      setError(te.has(key) ? te(key) : te('conflict'));
      return;
    }
    setPhone('');
    setName('');
    setCompany('');
    setRequestId(newKey());
    onDone(r.data.answer);
  };

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={t('title')}
      closeLabel={td('close')}
      footer={
        <Button variant="primary" size="lg" block disabled={busy || phone.trim().length < 5 || name.trim() === ''} onClick={() => void submit()}>
          {t('submit')}
        </Button>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label={t('phone')} hint={t('phoneHint')} required>
          <Input name="walkin-phone" type="tel" inputMode="tel" autoComplete="off" value={phone} maxLength={40} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field label={t('name')} required>
          <Input name="walkin-name" autoComplete="off" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('company')}>
          <Input name="walkin-company" autoComplete="off" value={company} maxLength={200} onChange={(e) => setCompany(e.target.value)} />
        </Field>
      </form>
    </BottomSheet>
  );
}
