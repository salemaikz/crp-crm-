// Отложенная отправка переноса (D-266): плитка переезжает сразу, на сервер перенос уходит через `delayMs` (5 с),
// «Отменить» снимает таймер — сервер об отмене не знает. Уход со страницы — немедленная отправка (keepalive).
// Чистая логика: таймеры и отправка подставляются, поэтому проверяется юнит-тестом без React и времени.

export interface MoveRequest {
  opId: string;
  dealId: string;
  /** Версия сделки в момент переноса (оптимистичная блокировка). */
  version: number;
  stageKey: string;
  /** Этап, с которого плитку перенесли (вернуть при отказе). */
  fromStageKey: string;
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const UNDO_DELAY_MS = 5000;

export class DeferredMoves {
  private readonly waiting = new Map<string, { move: MoveRequest; handle: unknown }>();

  constructor(
    private readonly opts: { delayMs: number; timers: Timers; send: (move: MoveRequest, o: { keepalive: boolean }) => void },
  ) {}

  /** Поставить перенос в очередь. Прежний неотправленный перенос этой сделки заменяется — побеждает последний. */
  schedule(move: MoveRequest): MoveRequest | null {
    const prev = this.waiting.get(move.dealId);
    if (prev) this.opts.timers.clear(prev.handle);
    const handle = this.opts.timers.set(() => {
      if (this.waiting.get(move.dealId)?.move.opId !== move.opId) return;
      this.waiting.delete(move.dealId);
      this.opts.send(move, { keepalive: false });
    }, this.opts.delayMs);
    this.waiting.set(move.dealId, { move, handle });
    return prev?.move ?? null;
  }

  /** «Отменить»: true, если перенос ещё не ушёл. */
  cancel(opId: string): MoveRequest | null {
    for (const [dealId, w] of this.waiting) {
      if (w.move.opId !== opId) continue;
      this.opts.timers.clear(w.handle);
      this.waiting.delete(dealId);
      return w.move;
    }
    return null;
  }

  /** Уход со страницы: всё неотправленное уходит сразу. */
  flushAll(): number {
    const all = [...this.waiting.values()];
    this.waiting.clear();
    for (const w of all) {
      this.opts.timers.clear(w.handle);
      this.opts.send(w.move, { keepalive: true });
    }
    return all.length;
  }

  has(dealId: string): boolean {
    return this.waiting.has(dealId);
  }

  dealIds(): string[] {
    return [...this.waiting.keys()];
  }

  get size(): number {
    return this.waiting.size;
  }
}
