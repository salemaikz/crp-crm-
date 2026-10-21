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
  format: 2;
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
  /** Время сборки (epoch-мс): совпадает с BUILT_AT водяного знака ядра образа. */
  builtAt: number;
  commit: string;
  /** Ключи релизов, которым будет доверять crmctl этой версии (kid и sha256 сырого ключа). */
  releaseKeys: { kid: string; sha256: string }[];
  /** Все члены архива, кроме manifest.json и каталогов. */
  files: { path: string; sha256: string; size: number }[];
}

/**
 * Проверка лицензии ядром образа (P10). Подпись пакета проверяет verify.ts (O4c, D-315) по deps.trust.
 */
export interface Verifier {
  /** Проверка действующей лицензии НОВЫМ образом до переключения (DEPLOY §5.2 п. 2). */
  verifyLicense(input: { image: string; licenseDir: string; installId: string }): Promise<Verdict>;
}

/** Доверенные открытые ключи подписи пакетов (kid → сырой ключ Ed25519 в base64). */
export interface Trust {
  /** Ключи релизов `rel-*`: вшиты в crmctl при сборке клиента (build-cli.mjs --release-keys). */
  release: Record<string, string>;
  /** Ключи `test-*`: только тесты, передаются через Deps. */
  test?: Record<string, string>;
}

export interface Deps {
  exec: Executor;
  io: Io;
  env: Record<string, string | undefined>;
  paths: Paths;
  verifier: Verifier;
  trust: Trust;
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
