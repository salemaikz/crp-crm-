'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Ellipsis, MessageCircle } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { useChannelModes } from '@/ui/channels';
import { chatAction } from '@/ui/messenger/openChat';
import { Alert, BottomSheet, Badge, Button, Card, Field, Input, List, ListItem, Select, useToast } from '@/ui/kit';
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
  // Чей номер: пусто — номер клиента, иначе id контакта
  const [contactId, setContactId] = useState('');
  // «⋯» у строки: действия над номером
  const [menu, setMenu] = useState<PhoneView | null>(null);
  const modes = useChannelModes();
  // Один opId на попытку: повтор при сбое сети с тем же номером не создаст второй
  const opId = useRef<string>(crypto.randomUUID());

  const contactName = (id: string | null) => contacts.find((c) => c.id === id)?.name ?? '';

  async function add(e: FormEvent) {
    e.preventDefault();
    if (busy || !value.trim()) return;
    setBusy(true);
    setError(null);
    const { result, data } = await send('POST', `/api/clients/${clientId}/phones`, { opId: opId.current, phone: value.trim(), ...(contactId ? { contactId } : {}) });
    setBusy(false);
    if (result.ok) {
      const status = (data as { status?: string } | null)?.status;
      toast.show(status === 'review' ? { message: t('phones.sentForReview'), tone: 'neutral' } : { message: t('phones.added'), tone: 'success' });
      opId.current = crypto.randomUUID();
      setValue('');
      setContactId('');
      setAdding(false);
      router.refresh();
      return;
    }
    if (result.kind !== 'network') opId.current = crypto.randomUUID();
    const stand = (data as { detail?: string } | null)?.detail === 'stand_phone';
    setError(result.kind === 'invalid' ? t(stand ? 'phones.standPhone' : 'phones.invalid') : t(`form.failure.${result.kind === 'fields' ? 'invalid' : result.kind}`));
  }

  async function act(p: PhoneView, body: { working: false } | { primary: true }) {
    const { result } = await send('PATCH', `/api/clients/phones/${p.id}`, body);
    setConfirm(null);
    setMenu(null);
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
          {phones.map((p) => {
            // WhatsApp у строки: только рабочий мобильный; в режиме окна чата кнопка одна, у основного номера, над карточкой
            const wa = p.working && p.kind === 'mobile' ? chatAction(p.e164, '', modes) : null;
            return (
              <ListItem
                key={p.id}
                title={<span className="k-num">{`${formatPhone(p.e164)}${p.ext ? ` (${t('phones.ext', { ext: p.ext })})` : ''}`}</span>}
                meta={[t(`phones.kind.${p.kind}`), contactName(p.contactId) || t('phones.ofClient'), p.primary && p.working ? t('phones.primary') : ''].filter(Boolean).join(' · ')}
                trailing={
                  <span className="flex flex-wrap items-center justify-end gap-1">
                    {!p.working && <Badge tone="danger">{t('phones.notWorking')}</Badge>}
                    {wa && wa.kind === 'link' && (
                      <Button href={wa.href} external target="_blank" rel="noopener noreferrer" variant="quiet" size="sm" iconOnly aria-label={t('phones.whatsapp', { phone: formatPhone(p.e164) })} data-testid="phone-whatsapp">
                        <MessageCircle aria-hidden="true" />
                      </Button>
                    )}
                    {canEdit && p.working && (
                      <Button variant="quiet" size="sm" iconOnly aria-label={t('phones.more', { phone: formatPhone(p.e164) })} data-testid="phone-more" onClick={() => setMenu(p)}>
                        <Ellipsis aria-hidden="true" />
                      </Button>
                    )}
                  </span>
                }
              />
            );
          })}
        </List>
      )}
      {adding && (
        <form onSubmit={add} className="mt-3 flex flex-col gap-3" noValidate>
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label={t('phones.newLabel')} hint={t('phones.newHint')}>
            <Input name="phone" type="tel" inputMode="tel" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
          </Field>
          {contacts.length > 0 && (
            <Field label={t('phones.whose')}>
              <Select name="contactId" value={contactId} onChange={(e) => setContactId(e.target.value)}>
                <option value="">{t('phones.ofClient')}</option>
                {contacts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name || t('contacts.noName')}
                  </option>
                ))}
              </Select>
            </Field>
          )}
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
      <BottomSheet open={menu !== null} onClose={() => setMenu(null)} title={menu ? formatPhone(menu.e164) : ''} closeLabel={t('form.close')}>
        {menu && (
          <div className="flex flex-col gap-1">
            {!menu.primary && (
              <Button variant="quiet" block flush onClick={() => void act(menu, { primary: true })}>
                {t('phones.makePrimary')}
              </Button>
            )}
            <Button
              variant="quiet"
              block
              flush
              onClick={() => {
                setConfirm(menu);
                setMenu(null);
              }}
            >
              {t('phones.markNotWorking')}
            </Button>
          </div>
        )}
      </BottomSheet>
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
