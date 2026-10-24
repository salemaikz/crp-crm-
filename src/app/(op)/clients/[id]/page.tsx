import { notFound, redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { can, page } from '@/server/access';
import { loadClientPage } from '@/server/domain/clients';
import { getMessengerConsent } from '@/server/domain/messenger';
import { loadChannelModes } from '@/ui/channels/loadModes';
import { Page } from '@/ui/kit';
import { WhatsappButton } from '@/ui/messenger/WhatsappButton';
import { ClientTasksPanel } from '../../tasks/_ui/ClientTasksPanel';
import { CallButton } from '../_ui/CallButton';
import { CardActions } from '../_ui/CardActions';
import { CardFieldsPanel } from '../_ui/CardFieldsPanel';
import { ClientHeader } from '../_ui/ClientHeader';
import { ClientsProviders } from '../_ui/ClientsProviders';
import { ContactsPanel } from '../_ui/ContactsPanel';
import { DealsPanel } from '../_ui/DealsPanel';
import { NotesPanel } from '../_ui/NotesPanel';
import { SummaryBlock } from '../_ui/SummaryBlock';
import { Counters } from '../_ui/Counters';
import { FeedPanel } from '../_ui/FeedPanel';
import { FieldsPanel } from '../_ui/FieldsPanel';
import { feedLabelsFor } from '../_ui/feedLabels.server';
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
  const { card, feed, legalForms, summary, pinnedNotes, deals, catalog } = r;
  const modes = await loadChannelModes(viewer);
  const tz = viewer.timeZone;
  // Отметка согласия нужна только окну чата провайдера; в режиме wa.me ничего не читаем
  const consent = modes.messenger.chat === 'iframe' ? await getMessengerConsent(viewer, card.id) : null;

  // Подписи ленты: общие с превью доски (feedLabelsFor) плюс номера и контакты этой карточки
  const labels: FeedLabels = await feedLabelsFor(viewer);
  // Поля карточки обзвона видны по своим правилам (cardFieldViewer): берём их из данных страницы
  for (const [obj, list] of [['client', card.fields.fields], ['contact', card.contactFields.fields], ['card', card.card?.fields.fields ?? []]] as const) {
    for (const f of list) {
      labels.fields[`${obj}:${f.key}`] = labelOf(f.label);
      for (const o of f.options) labels.options[`${obj}:${f.key}:${o.key}`] = labelOf(o.label);
    }
  }
  for (const p of card.phones) labels.phones[p.id] = formatPhone(p.e164);
  for (const c of card.contacts) labels.contacts[c.id] = c.name;

  return (
    <ClientsProviders>
      <Page width="wide">
        {/* Шапка на обе колонки: история справа начинается на одной высоте с первым блоком слева */}
        <ClientHeader card={card} legalForms={legalForms} timeZone={tz} />
        {/* Одна колонка на телефоне — minmax(0,1fr): ряд чипов ленты прокручивается сам, а не растягивает страницу */}
        <div className="grid grid-cols-[minmax(0,1fr)] gap-[var(--space-section)] lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)] lg:items-start">
          <div className="flex min-w-0 flex-col gap-4">
            <CallButton phone={card.primaryPhone} modes={modes} />
            {card.primaryPhone && card.primaryPhone.kind === 'mobile' && card.card && (
              <WhatsappButton cardId={card.card.id} clientId={card.id} phone={card.primaryPhone.e164} modes={modes} consent={consent} canEditConsent={card.can.edit} />
            )}
            <CardActions card={card} viewer={viewer} />
            <SummaryBlock summary={summary} catalog={catalog} timeZone={tz} />
            {card.card && <Counters head={card.card} timeZone={tz} />}
            <FieldsPanel client={card} legalForms={legalForms} />
            {card.card && <CardFieldsPanel cardId={card.card.id} version={card.card.version} fields={card.card.fields.fields} canEdit={card.can.editCard} />}
            {can(viewer, 'task.read') && <ClientTasksPanel clientId={card.id} clientName={card.name} canCreate={card.can.task} meId={viewer.userId} timeZone={tz} />}
            <NotesPanel key={pinnedNotes.map((n) => n.id).join(',')} clientId={card.id} pinned={pinnedNotes} canWrite={card.can.note} timeZone={tz} />
            <DealsPanel deals={deals} catalog={catalog} timeZone={tz} />
            <PhonesPanel clientId={card.id} phones={card.phones} contacts={card.contacts} canEdit={card.can.edit} />
            <ContactsPanel clientId={card.id} contacts={card.contacts} contactFields={card.contactFields.fields} canEdit={card.can.edit} />
          </div>
          <div className="min-w-0 lg:sticky lg:top-4">
            <FeedPanel clientId={card.id} canPin={card.can.note} initialItems={feed.items} initialNext={feed.next} timeZone={tz} labels={labels} />
          </div>
        </div>
      </Page>
    </ClientsProviders>
  );
});
