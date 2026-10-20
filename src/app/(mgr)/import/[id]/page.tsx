// Экран одной загрузки: карта владельцев → предпросмотр → «Применить». Чужая или несуществующая — 404.
import { notFound } from 'next/navigation';
import { page, type PageContext } from '@/server/access';
import { importService } from '@/server/domain/import';
import { actorOf } from '../actor';
import type { ImportDetails } from '../types';
import { DetailScreen } from './DetailScreen';

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ same?: string }> };

export default page({ perm: 'import.run' }, async ({ viewer, props }: PageContext<Props>) => {
  const { id } = await props.params;
  const { same } = await props.searchParams;
  const details: ImportDetails | null = await importService.getImport(actorOf(viewer), id, viewer.now);
  if (!details) notFound();
  const sameAt = same && /^\d{10,16}$/.test(same) ? Number(same) : null;
  return <DetailScreen details={details} sameFileAppliedAt={sameAt} />;
});
