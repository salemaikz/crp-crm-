// Экран РОП «Передача клиентов» (B9a): массовая передача карточек сотрудника. Страница с данными: только через page()
// с правом 'client.transfer'. За флагом FEATURE_BULK_TRANSFER: выключен — страницы нет (404).
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { page } from '@/server/access';
import { listTransferStaff, requireBulkFeature } from '@/server/domain/team';
import { TransferScreen } from './TransferScreen';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default page<Props, ReactNode>({ perm: 'client.transfer', target: 'section' }, async ({ viewer, props }) => {
  try {
    requireBulkFeature();
  } catch {
    notFound();
  }
  const raw = await props.searchParams;
  const from = typeof raw.from === 'string' ? raw.from : '';
  const { items } = await listTransferStaff(viewer, {});
  return <TransferScreen staff={items} initialFrom={items.some((s) => s.userId === from) ? from : ''} />;
});
