// crmctl license-clock status | reset --yes — правило часов лицензии (D-314, RUNBOOK «Лицензия» п. 5).
//
// status — время лицензии (last_seen_at), часы сервера и эпизод «часы позади» (длительность, блокировка).
// reset  — после починки часов, которые спешили больше чем на 48 ч: время лицензии ставится на показание часов,
//   эпизод «часы позади» и блокировка с причиной clock снимаются сразу, а не когда верные часы догонят. Это откат
//   времени лицензии назад: только при эпизоде, только с --yes, всегда запись license.clock_reset в аудите
//   (сколько часов откатили, была ли блокировка). Затем состояние пересчитывается (license.state_change в аудите).
// Исполняется внутри образа (нужны БД и ядро), как `job`; зарегистрирована в rawCommands scripts/crmctl/index.ts
// (ленивый импорт: хостовая копия crmctl стартует без ядра).
import { getDb, openScriptDb } from '../../src/server/platform/db';
import { licenseEnv, readLicenseRow, refreshLicense, resetLicenseClock } from '../../src/server/platform/license';

const USAGE = 'crmctl license-clock status\ncrmctl license-clock reset --yes   время лицензии — на показание часов (только при «часы позади»)';
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

export async function runLicenseClock(argv: string[]): Promise<number> {
  const [sub] = argv;
  if (sub !== 'status' && sub !== 'reset') {
    console.error(USAGE);
    return 2;
  }
  if (sub === 'reset' && !argv.includes('--yes')) {
    console.error('Сброс откатывает время лицензии на показание часов сервера. Сначала исправьте часы (chrony),');
    console.error('проверьте `date -u`, затем повторите с --yes. Сброс попадёт в журнал аудита (license.clock_reset).');
    return 2;
  }
  const close = await openScriptDb();
  try {
    const db = await getDb();
    const env = licenseEnv();
    if (sub === 'status') {
      const row = await db.tx((sql) => readLicenseRow(sql));
      if (!row) {
        console.log('лицензия: строки license_state нет');
        return 1;
      }
      const clock = env.clock();
      const since = row.clockBehindSince;
      const episodeH = since === null ? 0 : Math.floor(Math.max(0, (row.clockRealAt ?? since) - since) / H);
      console.log(`время лицензии: ${iso(row.lastSeenAt)}`);
      console.log(`часы сервера:   ${iso(clock)}`);
      console.log(since === null ? 'часы позади:    нет' : `часы позади:    ${episodeH} ч эпизода (блокировка после 48 ч)`);
      return 0;
    }
    const res = await resetLicenseClock(db, env);
    if (res.status === 'no_row') {
      console.error('лицензия: строки license_state нет — сбрасывать нечего');
      return 1;
    }
    if (res.status === 'not_behind') {
      console.log('Часы сервера не позади времени лицензии — сбрасывать нечего.');
      return 0;
    }
    const snap = await refreshLicense(db, env);
    console.log(`Сброшено: время лицензии откатилось на ${Math.floor(res.rewindMs / H)} ч${res.wasLocked ? ', блокировка «часы позади» снята' : ''}.`);
    console.log(`Состояние: ${snap.status}${snap.reason ? ` (${snap.reason})` : ''}. Приложение увидит его в течение минуты.`);
    return 0;
  } finally {
    await close();
  }
}
