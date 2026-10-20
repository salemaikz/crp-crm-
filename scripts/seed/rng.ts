// Детерминированный генератор для сида: одно и то же зерно даёт те же данные и те же id на любой машине.
import { createHash } from 'node:crypto';

/** Генератор mulberry32: быстрый, 32 бита состояния, достаточно для тестовых данных. */
export class Rng {
  private a: number;

  constructor(seed: string) {
    this.a = createHash('sha256').update(`rng|${seed}`).digest().readUInt32LE(0);
  }

  /** Число в [0, 1). */
  next(): number {
    this.a = (this.a + 0x6d2b79f5) | 0;
    let t = this.a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Целое в [min, max] включительно. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(list: readonly T[]): T {
    if (list.length === 0) throw new Error('Rng.pick: пустой список');
    return list[Math.floor(this.next() * list.length)] as T;
  }

  /** Новый перемешанный массив (Фишер — Йейтс). */
  shuffle<T>(list: readonly T[]): T[] {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  }
}

/** Устойчивый UUID (формат v4) из зерна, вида сущности и ключа: повторный запуск получает те же id. */
export function uuidFor(seed: string, kind: string, key: string | number): string {
  const h = createHash('sha256').update(`id|${seed}|${kind}|${key}`).digest('hex').slice(0, 32).split('');
  h[12] = '4';
  h[16] = ['8', '9', 'a', 'b'][Number.parseInt(h[16] as string, 16) % 4] as string;
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}
