// Реестр подкоманд crmctl. Ведёт ops (PLAN §4); здесь зарегистрирована только `config`.
import { pathToFileURL } from 'node:url';
import { runConfig } from './config';

export const COMMANDS: Record<string, (argv: string[]) => Promise<number>> = {
  config: runConfig,
};

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const run = cmd ? COMMANDS[cmd] : undefined;
  if (!run) {
    console.error(`Использование: crmctl <${Object.keys(COMMANDS).join('|')}> …`);
    return 1;
  }
  return run(rest);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
