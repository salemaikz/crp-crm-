'use client';

import { useTranslations } from 'next-intl';
import { useRef, useState, type FormEvent } from 'react';
import { Alert, BottomSheet, Button, Field, Input, ToastProvider, useToast } from '@/ui/kit';
import { send } from './requests';

/**
 * «Предложить контакт» (D-258): номер и название. Ответ сервера всегда «принято» — какой бы ни была причина
 * проверки, оператору она не показывается; ошибка только одна: номер не похож на рабочий (формат, а не база).
 * `opId` живёт до принятого ответа: повтор при сбое сети не создаёт второе предложение.
 */
/** Список клиентов вне ClientsProviders: тосты своего провайдера. */
export function ProposeSheet() {
  return (
    <ToastProvider>
      <ProposeForm />
    </ToastProvider>
  );
}

function ProposeForm() {
  const t = useTranslations('clients');
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<boolean | 'stand'>(false);
  const [busy, setBusy] = useState(false);
  const opId = useRef<string>(crypto.randomUUID());

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || phone.trim() === '' || name.trim() === '') return;
    setBusy(true);
    setError(null);
    setPhoneError(false);
    const { result, data } = await send('POST', '/api/clients/proposals', { opId: opId.current, phone: phone.trim(), name: name.trim() });
    setBusy(false);
    if (result.ok) {
      opId.current = crypto.randomUUID();
      setPhone('');
      setName('');
      setOpen(false);
      toast.show({ message: t('propose.sent'), tone: 'success' });
      return;
    }
    const detail = (data as { detail?: string } | null)?.detail;
    if (result.kind === 'invalid' && (detail === 'phone_invalid' || detail === 'stand_phone')) {
      setPhoneError(detail === 'stand_phone' ? 'stand' : true);
      return;
    }
    setError(t('propose.failure'));
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        {t('propose.open')}
      </Button>
      <BottomSheet open={open} onClose={() => setOpen(false)} title={t('propose.title')} description={t('propose.lead')} closeLabel={t('form.close')}>
        <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label={t('propose.phone')} error={phoneError === 'stand' ? t('propose.standPhone') : phoneError ? t('propose.invalidPhone') : undefined}>
            <Input name="propose-phone" type="tel" inputMode="tel" autoComplete="off" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={60} />
          </Field>
          <Field label={t('propose.name')}>
            <Input name="propose-name" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
          </Field>
          <Button type="submit" variant="primary" size="lg" block disabled={busy || phone.trim() === '' || name.trim() === ''}>
            {busy ? t('form.saving') : t('propose.submit')}
          </Button>
        </form>
      </BottomSheet>
    </>
  );
}
