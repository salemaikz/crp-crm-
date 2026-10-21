import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { page } from '@/server/access';
import { loadClientPage } from '@/server/domain/clients';
import { getMessengerConsent } from '@/server/domain/messenger';
import { loadChannelModes } from '@/ui/channels/loadModes';
import { TextLink } from '@/ui/kit';
import { WhatsappButton } from '@/ui/messenger/WhatsappButton';
import { CallButton } from '../_ui/CallButton';
import { ClientHeader } from '../_ui/ClientHeader';
import { ClientsProviders } from '../_ui/ClientsProviders';
import { ContactsPanel } from '../_ui/ContactsPanel';
import { Counters } from '../_ui/Counters';
import { FeedPanel } from '../_ui/FeedPanel';
import { FieldsPanel } from '../_ui/FieldsPanel';
import { formatPhone, labelOf } from '../_ui/format';
import { PhonesPanel } from '../_ui/PhonesPanel';
import type { FeedLabels } from '../_ui/types';

type Props = { params: Promise<{ id: string }> };

// Карточка клиента — одна для всех ролей; что видно и что можно править, решает сервер (охват и поля).
// Слитый клиент ведёт к выжившему, невидимый и несуществующий — одинаковый 404.
export default page<Props, ReactNode>({ perm: 'client.read', target: 'object' }, async ({ viewer, props }) => {
  const { id } = await props.params;
  const r = await loadClientPage(viewer, id);
  if (r.kind === 'redirect') redirect(r.to);
  if (r.kind === 'missing') notFound();
  const { card, feed, legalForms } = r;
  const [t, modes] = await Promise.all([getTranslations('clients'), loadChannelModes(viewer)]);
  const tz = viewer.timeZone;
  // Отметка согласия нужна только окну чата провайдера; в режиме wa.me ничего не читаем
  const consent = modes.messenger.chat === 'iframe' ? await getMessengerConsent(viewer, card.id) : null;

  // Подписи ленты: только видимые поля, варианты, номера и контакты карточки
  const labels: FeedLabels = { fields: {}, options: {}, phones: {}, contacts: {} };
  for (const [obj, list] of [['client', card.fields.fields], ['contact', card.contactFields.fields]] as const) {
    for (const f of list) {
      labels.fields[`${obj}:${f.key}`] = labelOf(f.label);
      for (const o of f.options) labels.options[`${obj}:${f.key}:${o.key}`] = labelOf(o.label);
    }
  }
  for (const f of legalForms) labels.options[`legal_form:${f.key}`] = labelOf(f.label);
  for (const p of card.phones) labels.phones[p.id] = formatPhone(p.e164);
  for (const c of card.contacts) labels.contacts[c.id] = c.name;

  return (
    <ClientsProviders>
      <main className="mx-auto w-full max-w-6xl px-4 py-4 lg:py-6">
        <p className="mb-3">
          <TextLink href="/clients">{t('card.back')}</TextLink>
        </p>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start">
          <div className="flex min-w-0 flex-col gap-4">
            <ClientHeader card={card} legalForms={legalForms} timeZone={tz} />
            <CallButton phone={card.primaryPhone} modes={modes} />
            {card.primaryPhone && card.primaryPhone.kind === 'mobile' && card.card && (
              <WhatsappButton cardId={card.card.id} clientId={card.id} phone={card.primaryPhone.e164} modes={modes} consent={consent} canEditConsent={card.can.edit} />
            )}
            {card.card && <Counters head={card.card} timeZone={tz} />}
            <FieldsPanel client={card} legalForms={legalForms} />
            <PhonesPanel clientId={card.id} phones={card.phones} contacts={card.contacts} canEdit={card.can.edit} />
            <ContactsPanel clientId={card.id} contacts={card.contacts} contactFields={card.contactFields.fields} canEdit={card.can.edit} />
          </div>
          <FeedPanel clientId={card.id} initialItems={feed.items} initialNext={feed.next} timeZone={tz} labels={labels} />
        </div>
      </main>
    </ClientsProviders>
  );
});
