// Экран РОП «Раздача»: пул, участники, журнал. Страница с данными: только через page() с правом 'pool.read'.
import { booking } from '@crm/core';
import type { ReactNode } from 'react';
import { can, page } from '@/server/access';
import { getJournal, getPool, listAbsences, listOwnerless, listParticipants, listProposals } from '@/server/domain/distribution';
import { DistributionScreen } from './DistributionScreen';
import type { DistributionData } from './types';

const POOL_PAGE = 50;
const JOURNAL_DAYS = 7;

export default page<unknown, ReactNode>({ perm: 'pool.read' }, async ({ viewer }) => {
  const [pool, participants, journal, absences, ownerless, proposals] = await Promise.all([
    getPool(viewer, { cursor: null, limit: POOL_PAGE }),
    listParticipants(viewer),
    getJournal(viewer, { from: booking.addDays(viewer.today, 1 - JOURNAL_DAYS), to: viewer.today }),
    listAbsences(viewer),
    listOwnerless(viewer, { cursor: null, limit: POOL_PAGE }),
    listProposals(viewer),
  ]);
  // присваивание проверяет, что формы из домена совместимы с типами клиентского экрана
  const data: DistributionData = {
    pool,
    participants,
    journal,
    absences,
    ownerless,
    proposals,
    today: viewer.today,
    canIssue: can(viewer, 'card.assign'),
    canManage: can(viewer, 'distribution.manage'),
    timeZone: viewer.timeZone,
  };
  return <DistributionScreen data={data} />;
});
