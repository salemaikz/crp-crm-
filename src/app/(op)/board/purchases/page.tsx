import { notFound } from 'next/navigation';
import { page, type PageContext } from '@/server/access';
import { dealsDeps, listMine } from '@/server/domain/deals';
import { isFeatureEnabled } from '@/server/platform/flags';
import { PurchasesScreen } from '@/ui/board/PurchasesScreen';
import { loadServiceLabels } from '../serviceLabels';

// «Мои покупки» (этап В, флаг OP_BOARD): сделки, засчитанные сотруднику по заслуге. Отбор и охват — в SQL
// `listMine` (собственный предикат «заслуга = я»); чужие клиенты показываются без названия. Флаг выключен — 404.
type Props = { searchParams?: Promise<{ cursor?: string }> };

export default page<Props, React.ReactNode>({ perm: 'deal.read', target: 'section' }, async ({ viewer, props }: PageContext<Props>) => {
  const { cursor } = (await props.searchParams) ?? {};
  if (!isFeatureEnabled('OP_BOARD') || viewer.spaceId === null) notFound();
  const deps = dealsDeps();
  const [data, serviceLabels] = await Promise.all([listMine(deps, viewer, { cursor: cursor ?? null }), loadServiceLabels(viewer)]);
  return <PurchasesScreen data={data} serviceLabels={serviceLabels} timeZone={viewer.timeZone} />;
});
