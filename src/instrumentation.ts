// Хук старта сервера Next 16 (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/
// instrumentation.md): register() выполняется один раз до приёма запросов. Здесь — проверка окружения
// production (D-155) и запуска сборки клиента: явная предзагрузка и инспектор — отказ, прочее — сигнал (D-312,
// D-314). Исключение из
// register Next 16.4 не останавливает процесс: сервер остаётся жить и отвечает 500 на всё. Поэтому отказ запуска — явный: сообщение в лог и выход с кодом 1.
// Режим стенда на Vercel (D-318): до проверки окружение процесса дополняется значениями стенда (адрес проекта,
// выведенные секреты, флаги); явно заданные переменные не меняются.
export async function register(): Promise<void> {
  // Условный импорт по NEXT_RUNTIME, как в гайде: в сборку edge модули node:* не попадают
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { applyVercelStandDefaults } = await import('./server/platform/stand');
    const stand = applyVercelStandDefaults(process.env);
    const { startupConfigProblems } = await import('./server/platform/env');
    const problems = startupConfigProblems(process.env);
    if (problems.length > 0) {
      const where = stand.active ? 'окружение стенда Vercel (docs/ops/VERCEL.md)' : 'окружение /etc/crm/app.env';
      console.error(`Запуск остановлен, ${where} не годится:\n- ${problems.join('\n- ')}`);
      process.exit(1);
      return;
    }
    const { checkRuntime, runtimeTamperMessage } = await import('./server/platform/license/runtime');
    const tamper = checkRuntime('app');
    if (tamper.length > 0) {
      console.error(`Запуск остановлен: процесс запущен не как в поставке (D-312). ${runtimeTamperMessage(tamper)}`);
      process.exit(1);
    }
  }
}
