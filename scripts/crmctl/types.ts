// Общие типы crmctl: исполнитель команд, ввод-вывод, зависимости. Всё внешнее (docker, ФС хоста,
// время, сеть) приходит через Deps, поэтому сценарии установки/обновления/отката проверяются
// в тестах без Docker.

export interface RunOptions {
  cwd?: string;
  /** Дополнительные переменные окружения поверх process.env. */
  env?: Record<string, string>;
  /** Что подать на stdin (SQL для psql и т. п.). */
  input?: string;
  timeoutMs?: number;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Исполнитель внешних команд. Не бросает на ненулевой код: решает вызывающий. */
export interface Executor {
  run(cmd: string, args: string[], opts?: RunOptions): Promise<RunResult>;
}

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

export interface Paths {
  /** /etc/crm: app.env, db.env, project.env (root, 0600). */
  etcDir: string;
  /** /var/lib/crm: state.json, license/, packages/, compose/. */
  libDir: string;
  /** Скрипт бэкапа (O3): вызывается перед миграциями. */
  backupCmd: string;
  /** /usr/local/lib/crm: node и crmctl.mjs, обновляются из образа текущей версии. */
  cliDir: string;
}

export interface HttpResponse {
  status: number;
  body: string;
}

/** Результат проверки подписи пакета или лицензии. reason и warning показываются оператору. */
export type Verdict = { ok: true; warning?: string } | { ok: false; reason: string };

export interface PackageManifest {
  customer: string;
  version: string;
  buildId: string;
  /** Последняя миграция SQL в пакете (имя файла): «версия схемы не ниже текущей». */
  schemaVersion: string;
  /** Версия схемы настроек (D-060); в обновлении не сравнивается, показывается в status. */
  configSchemaVersion: number;
  /** Минимальная версия, с которой можно обновиться; '' — без ограничения. */
  minFromVersion: string;
  images: { ref: string; digest: string }[];
}

/**
 * Проверки, которые реализуют другие задачи. Здесь только контракт.
 * Реализует O4c (подпись пакета, manifest.sig, Ed25519) и P10 (формат и состояния лицензии).
 */
export interface Verifier {
  verifyPackage(input: { dir: string; manifest: PackageManifest }): Promise<Verdict>;
  /** Проверка действующей лицензии НОВЫМ образом до переключения (DEPLOY §5.2 п. 2). */
  verifyLicense(input: { image: string; licenseDir: string; installId: string }): Promise<Verdict>;
}

export interface Deps {
  exec: Executor;
  io: Io;
  env: Record<string, string | undefined>;
  paths: Paths;
  verifier: Verifier;
  http: (url: string) => Promise<HttpResponse>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Криптослучайные байты (тесты подменяют, чтобы проверить вывод секретов). */
  randomBytes: (n: number) => Buffer;
  randomUuid: () => string;
}

/** Ошибка сценария: сообщение оператору и код выхода. */
export class CrmctlError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = 'CrmctlError';
  }
}
