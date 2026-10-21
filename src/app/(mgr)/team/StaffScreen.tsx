'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { UserPlus } from 'lucide-react';
import type { IssuedLink, StaffList, StaffRow } from './types';
import { Badge, Button, EmptyState, Modal, Page, PageHeader, Table, type BadgeTone, type TableColumn } from '@/ui/kit';
import { InviteForm } from './InviteForm';
import { LinkView } from './LinkView';
import { RowDialog } from './RowDialog';

/** Одно окно на экран (правило UX «не больше одного слоя»): содержимое сменяется по состоянию. */
type Dialog = { kind: 'invite' } | { kind: 'row'; id: string } | { kind: 'link'; link: IssuedLink; reset: boolean } | null;

const TONE: Record<StaffRow['status'], BadgeTone> = { active: 'success', invited: 'info', disabled: 'neutral' };

export function StaffScreen({ data, bulkEnabled }: { data: StaffList; bulkEnabled: boolean }) {
  const t = useTranslations('team');
  const router = useRouter();
  const [dialog, setDialog] = useState<Dialog>(null);
  const roles = new Map(data.roles.map((r) => [r.key, r.label]));
  const row = dialog?.kind === 'row' ? data.staff.find((s) => s.id === dialog.id) : undefined;
  const close = () => setDialog(null);

  const columns: TableColumn<StaffRow>[] = [
    {
      key: 'name',
      header: t('columns.name'),
      primary: true,
      cell: (s) => (
        <span className="flex flex-wrap items-center gap-2">
          <strong>{s.name}</strong>
          {s.isSelf && <span className="text-sm">{t('self')}</span>}
          {s.isAdmin && <Badge tone="brand">{t('adminBadge')}</Badge>}
        </span>
      ),
    },
    { key: 'phone', header: t('columns.phone'), cell: (s) => s.phoneMasked },
    { key: 'role', header: t('columns.role'), cell: (s) => (s.roleKey ? (roles.get(s.roleKey) ?? s.roleKey) : t('noRole')) },
    {
      key: 'status',
      header: t('columns.status'),
      cell: (s) => <Badge tone={s.inviteState === 'inactive' ? 'warning' : TONE[s.status]}>{s.inviteState === 'inactive' ? t('status.invitedInactive') : t(`status.${s.status}`)}</Badge>,
    },
    {
      key: 'actions',
      header: t('columns.actions'),
      align: 'right',
      cell: (s) =>
        s.isSelf || s.status === 'disabled' ? null : (
          <Button variant="secondary" size="sm" aria-label={t('actions.openFor', { name: s.name })} onClick={() => setDialog({ kind: 'row', id: s.id })}>
            {t('actions.open')}
          </Button>
        ),
    },
  ];

  let title = '';
  if (dialog?.kind === 'invite') title = t('invite.title');
  else if (dialog?.kind === 'row' && row) title = row.name;
  else if (dialog?.kind === 'link') title = dialog.reset ? t('link.titleReset') : t('link.titleInvite');

  return (
    <Page width="wide">
      <PageHeader
        title={t('title')}
        lead={t('lead')}
        actions={
          <Button onClick={() => setDialog({ kind: 'invite' })}>
            <UserPlus aria-hidden="true" size={18} /> {t('actions.invite')}
          </Button>
        }
      />
      <Table
        columns={columns}
        rows={data.staff}
        rowKey={(s) => s.id}
        empty={<EmptyState framed={false} title={t('empty.title')} description={t('empty.description')} />}
      />
      <Modal open={dialog !== null && (dialog.kind !== 'row' || row !== undefined)} onClose={close} title={title} closeLabel={t('actions.close')} dismissible={dialog?.kind !== 'link'}>
        {dialog?.kind === 'invite' && (
          <InviteForm roles={data.roles} onCancel={close} onIssued={(link) => { router.refresh(); setDialog({ kind: 'link', link, reset: false }); }} />
        )}
        {dialog?.kind === 'row' && row && (
          <RowDialog
            key={row.id}
            row={row}
            roles={data.roles}
            bulkEnabled={bulkEnabled}
            onChanged={() => router.refresh()}
            onClose={close}
            onLink={(kind, link) => setDialog({ kind: 'link', link, reset: kind === 'reset' })}
          />
        )}
        {dialog?.kind === 'link' && <LinkView link={dialog.link.link} ttlHours={dialog.link.ttlHours} onDone={close} />}
      </Modal>
    </Page>
  );
}
