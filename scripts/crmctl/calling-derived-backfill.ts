// crmctl calling-derived-backfill [--space <ключ>] — заполнить кэш признаков и горячести карточек (pipeline-v2 §7.1).
// Миграция колонки не заполняет: правила живут в одном месте (`refreshCardDerived`). Идемпотентно, `version` не трогает,
// безопасно повторять и запускать при работающей системе (занятые карточки пропускаются, их пересчитает запись).
import { systemActor } from '../../src/server/access/systemActor';
import { recomputeSpaceHeat } from '../../src/server/domain/cards';
import { getActiveConfig } from '../../src/server/platform/config/active';
import { openScriptDb } from '../../src/server/platform/db';

const USAGE = 'crmctl calling-derived-backfill [--space <ключ>]';

export async function runDerivedBackfill(argv: string[]): Promise<number> {
  const i = argv.indexOf('--space');
  const only = i >= 0 ? argv[i + 1] : undefined;
  if (argv.includes('--help') || (i >= 0 && !only)) {
    console.log(USAGE);
    return i >= 0 && !only ? 2 : 0;
  }
  const close = await openScriptDb();
  try {
    const cfg = await getActiveConfig();
    const spaces = Object.entries(cfg.spaces).filter(([key]) => !only || key === only);
    if (spaces.length === 0) {
      console.error('нет такого пространства');
      return 2;
    }
    for (const [key, s] of spaces) {
      const r = await recomputeSpaceHeat(systemActor(`crmctl.calling-derived-backfill@${key}`), { spaceId: s.spaceId });
      console.log(`${key}: карточек ${r.cards}, изменено ${r.changed}`);
    }
    return 0;
  } finally {
    await close();
  }
}
