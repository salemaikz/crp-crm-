import { notFound } from 'next/navigation';
import { page } from '@/server/access';
import { CallScreen } from '@/ui/call/CallScreen';
import { loadCallConfig } from './loadCallConfig';

// Главный экран оператора. Страница отдаёт только настройки (кнопки итогов, сроки перезвона); карточки приходят
// из GET /api/calls/queue и держатся в памяти страницы, на сервере их показ проверяет охват карточек.
export default page({ perm: 'card.outcome', target: 'section' }, async ({ viewer }) => {
  const config = await loadCallConfig(viewer);
  if (!config) notFound();
  return <CallScreen config={config} />;
});
