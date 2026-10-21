// Раздел «Отчёты» при выключенном FEATURE_REPORTS (D-295): отчётов за период нет, но полная выгрузка остаётся —
// это право клиента на свои данные (D-054, D-055). Здесь только её кнопка и ссылка на журнал выгрузок.
import { getTranslations } from 'next-intl/server';
import { Button, PageHeader } from '@/ui/kit';
import { FullExportDialog } from './FullExportDialog';

type Props = { journal: boolean; fullLimit: number };

export async function DataExportOnly({ journal, fullLimit }: Props) {
  const t = await getTranslations('reports');
  return (
    <>
      <PageHeader title={t('dataOnly.title')} lead={t('dataOnly.lead')} />
      <section aria-label={t('dataOnly.title')} className="mb-4 flex flex-wrap items-start gap-2">
        <FullExportDialog limit={fullLimit} />
        {journal && (
          <Button variant="quiet" href="/reports/exports">
            {t('journal.link')}
          </Button>
        )}
      </section>
    </>
  );
}
