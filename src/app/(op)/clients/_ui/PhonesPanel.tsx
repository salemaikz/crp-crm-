'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useRef, useState, type FormEvent } from 'react';
import { Alert, BottomSheet, Badge, Button, Card, Field, Input, List, ListItem, useToast } from '@/ui/kit';
import { formatPhone } from './format';
import { send } from './requests';
import type { ContactView, PhoneView } from './types';

type Props = { clientId: string; phones: PhoneView[]; contacts: ContactView[]; canEdit: boolean };

export function PhonesPanel({ clientId, phones, contacts, canEdit }: Props) {
  const t = useTranslations('clients');
  const router = useRouter();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<PhoneView | null>(null);
  // Один opId на попытку: повтор при сбое сети с тем же номером не создаст второй
  const opId = useRef<string>(crypto.randomUUID());

  const contactName = (id: string | null) => contacts.find((c) => c.id === id)?.name ?? '';

  async function add(e: FormEvent) {
    e.preventDefault();
    if (busy || !value.trim()) return;
    setBusy(true);
    setError(null);
    const { result, data } = await send('POST', `/api/clients/${clientId}/phones`, { opId: opId.current, phone: value.trim() });
    setBusy(false);
    if (result.ok) {
      const status = (data as { status?: string } | null)?.status;
      toast.show(status === 'review' ? { message: t('phones.sentForReview'), tone: 'neutral' } : { message: t('phones.added'), tone: 'success' });
      opId.current = crypto.randomUUID();
      setValue('');
      setAdding(false);
      router.refresh();
      return;
    }
    if (result.kind !== 'network') opId.current = crypto.randomUUID();
    setError(result.kind === 'invalid' ? t('phones.invalid') : t(`form.failure.${result.kind === 'fields' ? 'invalid' : result.kind}`));
  }

  async function act(p: PhoneView, body: { working: false } | { primary: true }) {
    const { result } = await send('PATCH', `/api/clients/phones/${p.id}`, body);
    setConfirm(null);
    if (result.ok) {
      toast.show({ message: t('phones.updated'), tone: 'success' });
      router.refresh();
    } else {
      toast.show({ message: t(`form.failure.${result.kind === 'fields' ? 'invalid' : result.kind}`), tone: 'danger' });
    }
  }

  return (
    <Card as="section" aria-labelledby="client-phones-title">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 id="client-phones-title" className="text-lg font-semibold">
          {t('phones.title')}
        </h2>
        {canEdit && !adding && (
          <Button variant="quiet" size="sm" onClick={() => setAdding(true)}>
            {t('phones.add')}
          </Button>
        )}
      </div>
      {phones.length === 0 ? (
        <p className="text-[var(--text-2)]">{t('phones.empty')}</p>
      ) : (
        <List>
          {phones.map((p) => (
            <ListItem
              key={p.id}
              title={`${formatPhone(p.e164)}${p.ext ? ` (${t('phones.ext', { ext: p.ext })})` : ''}`}
              meta={[t(`phones.kind.${p.kind}`), contactName(p.contactId)].filter(Boolean).join(' · ')}
              trailing={
                <span className="flex flex-wrap items-center justify-end gap-2">
                  {p.primary && p.working && <Badge tone="brand">{t('phones.primary')}</Badge>}
                  {!p.working && <Badge tone="danger">{t('phones.notWorking')}</Badge>}
                </span>
              }
            />
          ))}
        </List>
      )}
      {canEdit && phones.some((p) => p.working) && (
        <ul className="mt-2 flex flex-col gap-1" aria-label={t('phones.actions')}>
          {phones
            .filter((p) => p.working)
            .map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 text-[var(--text-2)]">{formatPhone(p.e164)}</span>
                {!p.primary && (
                  <Button variant="quiet" size="sm" onClick={() => act(p, { primary: true })}>
                    {t('phones.makePrimary')}
                  </Button>
                )}
                <Button variant="quiet" size="sm" onClick={() => setConfirm(p)}>
                  {t('phones.markNotWorking')}
                </Button>
              </li>
            ))}
        </ul>
      )}
      {adding && (
        <form onSubmit={add} className="mt-3 flex flex-col gap-3" noValidate>
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label={t('phones.newLabel')} hint={t('phones.newHint')}>
            <Input name="phone" type="tel" inputMode="tel" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
          </Field>
          <div className="flex gap-3">
            <Button type="submit" variant="secondary" disabled={busy || !value.trim()}>
              {busy ? t('form.saving') : t('phones.addSubmit')}
            </Button>
            <Button type="button" variant="quiet" onClick={() => { setAdding(false); setError(null); }}>
              {t('form.cancel')}
            </Button>
          </div>
        </form>
      )}
      <BottomSheet
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={t('phones.confirmTitle')}
        description={confirm ? t('phones.confirmText', { phone: formatPhone(confirm.e164) }) : undefined}
        closeLabel={t('form.close')}
        footer={
          <>
            <Button variant="danger" onClick={() => confirm && act(confirm, { working: false })}>
              {t('phones.confirmYes')}
            </Button>
            <Button variant="quiet" onClick={() => setConfirm(null)}>
              {t('form.cancel')}
            </Button>
          </>
        }
      />
    </Card>
  );
}
