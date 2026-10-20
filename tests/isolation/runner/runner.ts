// Ядро прогона изоляции (ARCHITECTURE §5.3, D-017): для записи манифеста оператор A обращается к объекту
// оператора B. Раннер не знает модулей: читает tests/isolation/manifest/*.ts, находит код по AST (appScan) и
// возвращает список нарушений — тест их только сверяет, а самопроверка может ждать нарушения у плохих примеров.
//
// Объектная запись (target: 'object'):
//   A → id объекта B           : 404, как у несуществующего id (тот же статус, тело, заголовки);
//   в ответе/HTML нет названия, номера, БИН и контактов клиента B; снимок `touches` до/после равен;
//   B → свой объект            : не 404 (контроль: запись не «404 на всё»), если у роли B есть право;
//   без сессии                 : 401/переход на вход/404, ничего не утекает, снимок равен.
// Общий объект (shared, D-161): A с разрешением → не 404 и без данных клиентов B; несуществующий → 404;
//   B видит данные своего клиента (если ownerSees) — иначе проверка утечек пустая.
// Раздел (target: 'section'): A и гость получают не-5xx ответ без данных клиентов B; недопустимая попытка
//   мутации (гость, публичный вход с заведомо неверным телом) не меняет `touches`.
// Мутации: при лицензии «только чтение» обёрнутая мутация → 423, мутация безопасности (D-054) — не 423.
import { scanApp, type AppUnit } from '../../helpers/appScan';
import { matchEntries, type Entry } from '../../helpers/manifestCoverage';
import { createTestDb, type TestDb } from '../../../src/server/platform/db/testing';
import { can } from '../../../src/server/access/viewer';
import { resetAccessForTests } from '../../../src/server/access/testing';
import type { Viewer } from '../../../src/server/access/types';
import { actAs, enterSeedWorld, viewerOf } from '../harness/actors';
import { applySeedConfig } from '../harness/config';
import { allEntries } from '../harness/load';
import { U, seedIsolation } from '../harness/seed';
import { crashViolations, leakViolations, leaks, notFoundViolations, snapshotViolations, type Reply } from './checks';
import { invoke } from './invoke';
import { FOREIGN, allForeignNeedles, markFixtures, needlesOf } from './objects';
import { snapshotTables } from './snapshot';

export const MISSING_ID = 'zz-no-such-object';
/** Гость получает отказ или переход на вход (404 — для объектов). */
const GUEST_OK = [401, 302, 303, 307, 308, 404];

/**
 * Разрешение записи есть у РОЛИ сотрудника (для контроля «свой объект открывается»). Владение объектом
 * даёт только охват роли: отношения (duty_today, booked_with_me) открывают другой объект — мероприятие
 * дежурного, БК консультанта, — поэтому оператор с `duty_today` не владеет явкой своих записей (D-161).
 */
function allowed(v: Viewer, perm: Entry['perm']): boolean {
  if (perm === 'public' || perm === 'authenticated') return true;
  if (perm === 'admin') return v.isAdmin;
  return v.grants.has(perm) && can(v, perm);
}

export type RunnerOptions = {
  /** Каталог манифестов (по умолчанию tests/isolation/manifest). */
  manifestDir?: string;
  /** Корень исходников с каталогом app (по умолчанию src). */
  srcDir?: string;
};

export type Runner = {
  entries: readonly Entry[];
  unitOf(entry: Entry): AppUnit | undefined;
  /** Нарушения записи; пусто — запись изолирована. */
  check(entry: Entry): Promise<string[]>;
  close(): Promise<void>;
};

export async function createRunner(opts: RunnerOptions = {}): Promise<Runner> {
  const entries = await allEntries(opts.manifestDir);
  const units = scanApp(opts.srcDir);
  const unitOf = new Map<Entry, AppUnit>();
  for (const [u, e] of matchEntries(units, entries)) unitOf.set(e, u);

  const db: TestDb = await createTestDb();
  await seedIsolation(db.sql);
  await applySeedConfig();
  await markFixtures(db.sql);
  enterSeedWorld();
  const viewerA = await viewerOf(U.opA);
  const viewerB = await viewerOf(U.opB);
  const everyone = await allForeignNeedles(db.sql);

  let closed = false;

  async function check(entry: Entry): Promise<string[]> {
    const unit = unitOf.get(entry);
    if (!unit) return ['запись без кода: нет маршрута/страницы/действия (см. тест покрытия манифеста)'];
    const v: string[] = [];
    const snap = () => snapshotTables(db.sql, entry.touches ?? []);
    const wrapped = unit.wrapped !== null;
    try {
      if (entry.target === 'object') {
        const idParam = entry.idParam;
        if (!idParam) return ['объектной записи нужен idParam'];
        const foreign = FOREIGN[idParam.entity];
        const needles = await needlesOf(db.sql, idParam.entity);
        const before = await snap();
        const a = await invoke(unit, entry, { userId: U.opA, id: foreign.id });
        const missing = await invoke(unit, entry, { userId: U.opA, id: MISSING_ID });
        v.push(...crashViolations('A → чужой объект', a), ...crashViolations('A → несуществующий', missing));
        if (entry.shared && wrapped && allowed(viewerA, entry.perm)) {
          // Общий объект: A его видит, но ни одного клиента B в ответе; несуществующий — 404
          if (a.status === 404) v.push('общий объект: A с разрешением получил 404 — объект не общий (манифест или охват)');
          if (missing.status !== 404) v.push(`несуществующий объект: ждали 404, получили ${missing.status}`);
          v.push(...leakViolations('A → общий объект', a, everyone));
        } else {
          v.push(...notFoundViolations({ foreign: a, missing, foreignId: foreign.id, missingId: MISSING_ID }));
          v.push(...leakViolations('A → чужой объект', a, needles));
        }
        v.push(...leakViolations('A → несуществующий', missing, needles));
        v.push(...snapshotViolations('A → чужой объект', before, await snap()));

        // Гость: не 5xx, без данных, без изменений
        const guest = await invoke(unit, entry, { userId: null, id: foreign.id });
        v.push(...crashViolations('гость', guest), ...leakViolations('гость', guest, needles));
        if (wrapped && !GUEST_OK.includes(guest.status)) v.push(`гость: ждали 401/переход на вход/404, получили ${guest.status}`);
        v.push(...snapshotViolations('гость', before, await snap()));

        // Контроль: хозяин объекта не получает 404 (иначе проверка пустая)
        if (wrapped && allowed(viewerB, entry.perm)) {
          const own = await invoke(unit, entry, { userId: U.opB, id: foreign.id });
          if (own.status === 404) v.push('контроль: оператор B получил 404 на свой объект — запись не проверяет изоляцию (синтетика или разрешение)');
          v.push(...crashViolations('контроль: B → свой объект', own));
          if (entry.shared?.ownerSees && leaks(own.body, needles).length === 0) {
            v.push('контроль: в ответе B нет данных его клиента — проверка утечек у A пустая (синтетика или ответ)');
          }
        }
      } else {
        const before = await snap();
        const a = await invoke(unit, entry, { userId: U.opA });
        v.push(...crashViolations('A', a), ...leakViolations('A', a, everyone));
        const guest = await invoke(unit, entry, { userId: null });
        v.push(...crashViolations('гость', guest), ...leakViolations('гость', guest, everyone));
        if (wrapped && entry.perm !== 'public' && !GUEST_OK.includes(guest.status)) v.push(`гость: ждали 401/переход на вход/404, получили ${guest.status}`);
        if (entry.mutation && entry.perm === 'public') v.push(...snapshotViolations('публичная попытка', before, await snap()));
      }

      // Лицензия «только чтение»: обёрнутая мутация → 423; мутация безопасности D-054 проходит блокировку
      if (wrapped && entry.mutation && entry.perm !== 'public') {
        enterSeedWorld({ license: 'read_only' });
        try {
          const id = entry.idParam ? FOREIGN[entry.idParam.entity].id : undefined;
          const locked: Reply = await invoke(unit, entry, { userId: U.opB, ...(id ? { id } : {}) });
          if (entry.securityMutation) {
            if (locked.status === 423) v.push('лицензия read_only: мутация безопасности (D-054) заблокирована');
          } else if (locked.status !== 423) {
            v.push(`лицензия read_only: мутация не заблокирована (статус ${locked.status}, ждали 423)`);
          }
        } finally {
          enterSeedWorld();
        }
      }
    } catch (e) {
      v.push(`прогон упал: ${String((e as { message?: unknown } | null)?.message ?? e).slice(0, 300)}`);
    } finally {
      actAs(null);
    }
    return v;
  }

  return {
    entries,
    unitOf: (e) => unitOf.get(e),
    check,
    close: async () => {
      if (closed) return;
      closed = true;
      resetAccessForTests();
      await db.close();
    },
  };
}
