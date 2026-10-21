// Хук старта сервера Next 16 (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/
// instrumentation.md): register() выполняется один раз до приёма запросов. Здесь — проверка окружения
// production (D-155) и запуска сборки клиента: предзагрузка и инспектор — отказ (D-312). Исключение из
// register Next 16.4 не останавливает процесс: сервер остаётся жить и отвечает 500 на всё. Поэтому отказ запуска — явный: сообщение в лог и выход с кодом 1.
export async function register(): Promise<void> {
  // Условный импорт по NEXT_RUNTIME, как в гайде: в сборку edge модули node:* не попадают
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startupConfigProblems } = await import('./server/platform/env');
    const problems = startupConfigProblems(process.env);
    if (problems.length > 0) {
      console.error(`Запуск остановлен, окружение /etc/crm/app.env не годится:\n- ${problems.join('\n- ')}`);
      process.exit(1);
      return;
    }
    const { currentRuntimeFacts, runtimeTamperMessage, runtimeTamperProblems } = await import('./server/platform/license/runtime');
    const tamper = runtimeTamperProblems(currentRuntimeFacts());
    if (tamper.length > 0) {
      console.error(`Запуск остановлен: процесс запущен не как в поставке (D-312). ${runtimeTamperMessage(tamper)}`);
      process.exit(1);
    }
  }
}
