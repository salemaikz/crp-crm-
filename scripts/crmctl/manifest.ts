// Версии пакета и проверка каталога. Формат манифеста и архива — package-format.ts, проверка подписи и
// распаковка — verify.ts (docs/ops/release-design.md).
import { stat } from 'node:fs/promises';

export const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** Сравнение x.y.z[-pre]: отрицательное, если a < b. Пререлиз младше релиза с тем же x.y.z. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', pre = ''] = v.split(/[-+]/, 2);
    return { n: core.split('.').map(Number), pre: v.includes('-') ? pre : '' };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa.n[i] ?? 0) - (pb.n[i] ?? 0);
    if (d !== 0) return d;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === '') return 1;
  if (pb.pre === '') return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}
