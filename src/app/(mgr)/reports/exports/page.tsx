// Журнал выгрузок (R3b §2.4, PROCESS 8.6): администратор — вся установка, `export.journal` (директор) — своё
// пространство. Остальным — 404 (сервис отвечает ForbiddenError, обёртка page() превращает его в notFound()).
import { getTranslations } from 'next-intl/server';
import { can, page } from '@/server/access';
import { JOURNAL_PAGE, getExportJournal } from '@/server/domain/reports';
import { Page, PageHeader } from '@/ui/kit';
import { ExportJournal } from './ExportJournal';
import type { JournalPage } from './types';

export default page({ perm: 'authenticated' }, async ({ viewer }) => {
  const t = await getTranslations('reports.journal');
  // присваивание проверяет, что форма из домена совместима с типами клиентского экрана
  const first: JournalPage = await getExportJournal(viewer, { before: null, limit: JOURNAL_PAGE });
  return (
    <Page width="list">
      <PageHeader title={t('title')} lead={t('lead')} />
      <ExportJournal initial={first} timeZone={viewer.timeZone} showBack={viewer.spaceId !== null && can(viewer, 'report.view')} />
    </Page>
  );
});
