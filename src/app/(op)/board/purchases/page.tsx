import { notFound } from 'next/navigation';
import { page } from '@/server/access';
import { dealsDeps, listMine } from '@/server/domain/deals';
import { isFeatureEnabled } from '@/server/platform/flags';
import { PurchasesScreen } from '@/ui/board/PurchasesScreen';

// «Мои покупки» (этап В, флаг OP_BOARD): сделки, засчитанные сотруднику по заслуге. Отбор и охват — в SQL
// `listMine` (собственный предикат «заслуга = я»); чужие клиенты показываются без названия. Флаг выключен — 404.
export default page({ perm: 'deal.read', target: 'section' }, async ({ viewer }) => {
  if (!isFeatureEnabled('OP_BOARD') || viewer.spaceId === null) notFound();
  const deps = dealsDeps();
  const [data, settings] = await Promise.all([listMine(deps, viewer), deps.settings(viewer.spaceId, deps.now())]);
  const serviceLabels = Object.fromEntries(settings.serviceTypes.map((s) => [s.key, s.label.ru]));
  return <PurchasesScreen data={data} serviceLabels={serviceLabels} timeZone={viewer.timeZone} />;
});
