// «Как работать»: справка по ролям (docs/pv2-polish-plan.md S3). Право сверх входа не нужно, оболочку выбирает
// RoleShell по роли, как у /notifications. Данных клиентов нет: только шаблоны и подписи из настроек установки.
// Якоря: board, move, trash, callback, attend, purchases (контракт К4: на них ссылается «?» с доски). Флаг OP_BOARD выключен — 404.
import { Flame } from 'lucide-react';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { can, page, scopeOf, type PageContext } from '@/server/access';
import { roleMenuOf } from '@/ui/shells/loadMenu';
import { isFeatureEnabled } from '@/server/platform/flags';
import { Badge, Card, Page, PageHeader, Section, type BadgeTone } from '@/ui/kit';
import { helpKindOf, sectionsFor } from './helpData';
import { itemsFor, type HelpExt } from './helpItems';
import { loadHelp } from './loadHelp';

const TONES: readonly BadgeTone[] = ['success', 'warning', 'info', 'danger', 'neutral', 'brand'];

export default page<Record<string, never>, React.ReactNode>({ perm: 'authenticated' }, async ({ viewer }: PageContext<Record<string, never>>) => {
  if (!isFeatureEnabled('OP_BOARD')) notFound();
  const [t, tb, tn, tg, ts, menu] = await Promise.all([
    getTranslations('help'),
    getTranslations('board'),
    getTranslations('shell.nav'),
    getTranslations('shell.group'),
    getTranslations('booking.status'),
    roleMenuOf(viewer),
  ]);
  const data = await loadHelp(viewer, (state) => tb(`state.${state}` as 'state.new'));
  const kind = helpKindOf(menu);
  const scope = scopeOf(viewer, 'card.read');
  const ids = sectionsFor(kind, {
    wideCards: can(viewer, 'card.read') && (scope === 'space' || scope === 'all'),
    canReports: can(viewer, 'report.view') || can(viewer, 'pool.read'),
    canTasks: can(viewer, 'task.read'),
  });
  const ext: HelpExt = {
    sortHeat: tb('sort.heat'),
    callNext: tb('callNext'),
    moveTitle: tb('move.title'),
    moreReasons: tb('trash.more'),
    owner: tb('manager.owner'),
    badge: (event) => tb('badge.attendedGroup', { event }),
    toneWord: (tone) => ((TONES as readonly string[]).includes(tone) ? t(`tone.${tone}` as 'tone.success') : ''),
    nav: { purchases: tn('purchases'), duty: tn('duty'), consultations: tn('consultations'), tasks: tn('tasks') },
    group: { work: tg('work'), analytics: tg('analytics') },
    attended: ts('attended'),
    noShow: ts('no_show'),
  };
  const flags = { callbackV2: isFeatureEnabled('CALLBACK_V2'), canOutcome: can(viewer, 'card.outcome') && !viewer.readOnly };
  return (
    <Page width="list">
      <PageHeader title={t('title')} lead={t('lead')} />
      <nav aria-label={t('toc')} className="flex flex-wrap gap-2">
        {ids.map((id) => (
          <a key={id} href={`#${id}`} className="k-chip">
            {t(`sections.${id}.title` as 'sections.board.title')}
          </a>
        ))}
      </nav>
      {ids.map((id) => (
        <Section key={id} id={id} title={t(`sections.${id}.title` as 'sections.board.title')} className="scroll-mt-4">
          <Card padding="md">
            <ul className="flex flex-col gap-3">
              {itemsFor(id, kind, data, ext, flags).map((item, i) => (
                <li key={`${item.key}-${i}`} className="flex items-start gap-3">
                  {item.key === 'fireToday' || item.key === 'fireOverdue' ? (
                    <span className="mt-0.5 shrink-0" style={{ color: item.key === 'fireOverdue' ? 'var(--danger)' : 'var(--warning)' }}>
                      <Flame size={18} aria-hidden="true" />
                    </span>
                  ) : item.tone ? (
                    <Badge tone={(TONES as readonly string[]).includes(item.tone) ? (item.tone as BadgeTone) : 'neutral'}>{item.params.tone}</Badge>
                  ) : null}
                  <span className="min-w-0">{t(`sections.${id}.items.${item.key}` as 'sections.board.items.what', item.params)}</span>
                </li>
              ))}
            </ul>
          </Card>
        </Section>
      ))}
      <p style={{ color: 'var(--text-2)' }}>{t('support')}</p>
    </Page>
  );
});
