// Outbox итогов на устройстве (ARCHITECTURE §7, D-063). Итог сначала ложится сюда с opId, созданным на
// устройстве, и уходит на сервер после окна отмены. Повтор безопасен: сервер идемпотентен по opId.
// Класс не знает про React и браузер: хранилище, транспорт и часы приходят снаружи (тесты подменяют их).
import type { OutboxStore } from './outboxStore';
import { OUTBOX_RETRY_BASE_MS, OUTBOX_RETRY_MAX_MS, type OutboxEntry, type OutcomeKind, type OutcomeRequest } from './types';

/** Ответ сервера на отправку итога: статус и код ошибки из тела (если есть). */
export interface SendResult {
  status: number;
  code?: string;
}

/** Сеть: бросает исключение, если ответа нет. Заголовки устройства (X-Outbox-Pending …) добавляет транспорт. */
export type OutcomeSender = (request: OutcomeRequest) => Promise<SendResult>;

export type Verdict = 'sent' | 'rejected' | 'retry';

/**
 * Что делать с записью после ответа. 2xx — готово. 400/403/404 — сервер не примет никогда (проверка шторки,
 * чужая или переданная карточка): убрать и показать оператору. 401, 423 (лицензия «только чтение»), 408, 429
 * и 5xx — оставить и повторить (D-063, calls-design §11).
 */
export function classify(status: number): Verdict {
  if (status >= 200 && status < 300) return 'sent';
  if (status === 401 || status === 408 || status === 423 || status === 429 || status >= 500) return 'retry';
  return 'rejected';
}

/** Задержка перед следующей попыткой: 3 с, 6 с, 12 с … не больше минуты. */
export function backoffMs(attempts: number): number {
  return Math.min(OUTBOX_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), OUTBOX_RETRY_MAX_MS);
}

export interface NewOutboxItem {
  request: OutcomeRequest;
  title: string;
  kind: OutcomeKind;
  /** Окно отмены, мс. */
  undoMs: number;
}

export interface FlushReport {
  sent: string[];
  rejected: Array<{ opId: string; code: string }>;
  retry: string[];
  /** Прервано из-за сети. */
  offline: boolean;
}

export interface OutboxDeps {
  store: OutboxStore;
  send: OutcomeSender;
  userId: string;
  now?: () => number;
  /** Число записей или состав изменились. */
  onChange?: () => void;
}

export class Outbox {
  private readonly store: OutboxStore;
  private readonly send: OutcomeSender;
  private readonly userId: string;
  private readonly now: () => number;
  private readonly onChange: () => void;
  private entries = new Map<string, OutboxEntry>();
  private inFlight = new Set<string>();
  private running: Promise<FlushReport> | null = null;
  private lastFlush: number | null = null;
  private loaded = false;

  constructor(deps: OutboxDeps) {
    this.store = deps.store;
    this.send = deps.send;
    this.userId = deps.userId;
    this.now = deps.now ?? (() => Date.now());
    this.onChange = deps.onChange ?? (() => undefined);
  }

  /** Прочитать сохранённое (после перезапуска приложения). */
  async load(): Promise<void> {
    this.entries = new Map((await this.store.all(this.userId)).map((e) => [e.opId, e]));
    const last = await this.store.getMeta('lastFlushAt');
    this.lastFlush = last ? Number(last) : null;
    this.loaded = true;
    this.onChange();
  }

  /** Сколько итогов ещё не доехало (идёт в X-Outbox-Pending). */
  pendingCount(): number {
    return this.entries.size;
  }

  lastFlushAt(): number | null {
    return this.lastFlush;
  }

  has(opId: string): boolean {
    return this.entries.has(opId);
  }

  /** Карточки с неотправленным итогом: их сервер ещё считает «к звонку» (параметр exclude очереди). */
  cardIds(): string[] {
    return [...new Set([...this.entries.values()].map((e) => e.request.cardId))];
  }

  list(): OutboxEntry[] {
    return [...this.entries.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Положить итог на устройство. Запись сначала на диск, потом в память: потерять итог нельзя. */
  async enqueue(item: NewOutboxItem): Promise<OutboxEntry> {
    const now = this.now();
    const entry: OutboxEntry = {
      opId: item.request.opId,
      userId: this.userId,
      request: item.request,
      notBefore: now + Math.max(0, item.undoMs),
      attempts: 0,
      retryAt: 0,
      createdAt: now,
      title: item.title,
      kind: item.kind,
    };
    await this.store.put(entry);
    this.entries.set(entry.opId, entry);
    this.onChange();
    return entry;
  }

  /** «Отменить»: убрать из outbox, пока запись не ушла. false — уже отправляется или отправлена. */
  async cancel(opId: string): Promise<boolean> {
    if (this.inFlight.has(opId) || !this.entries.has(opId)) return false;
    await this.store.remove(opId);
    this.entries.delete(opId);
    this.onChange();
    return true;
  }

  /** Когда в следующий раз стоит пробудиться: самая ранняя запись, у которой окно отмены и пауза прошли. */
  nextDueAt(): number | null {
    let min: number | null = null;
    for (const e of this.entries.values()) {
      if (this.inFlight.has(e.opId)) continue;
      const at = Math.max(e.notBefore, e.retryAt);
      if (min === null || at < min) min = at;
    }
    return min;
  }

  /**
   * Отправить всё, что пора. `force` — не ждать ни окна отмены, ни паузы после ошибки (оператор пошёл дальше);
   * `ignoreBackoff` — окно отмены уважать, паузу после ошибки нет (вернулась сеть).
   * Одновременно идёт один проход; повторный вызов получает тот же результат.
   */
  flush(opts: { force?: boolean; ignoreBackoff?: boolean } = {}): Promise<FlushReport> {
    if (this.running) return this.running;
    this.running = this.run(opts).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Отправить сразу одну запись (оператор нажал «Позвонить» на следующей карточке). */
  async flushNow(opId: string): Promise<void> {
    if (this.running) await this.running;
    const e = this.entries.get(opId);
    if (!e) return;
    await this.attempt(e, { sent: [], rejected: [], retry: [], offline: false });
  }

  private async run(opts: { force?: boolean; ignoreBackoff?: boolean }): Promise<FlushReport> {
    if (!this.loaded) await this.load();
    const report: FlushReport = { sent: [], rejected: [], retry: [], offline: false };
    const now = this.now();
    const due = this.list().filter((e) => opts.force === true || (e.notBefore <= now && (opts.ignoreBackoff === true || e.retryAt <= now)));
    for (const e of due) {
      if (!this.entries.has(e.opId)) continue;
      const proceed = await this.attempt(e, report);
      if (!proceed) break;
    }
    return report;
  }

  /** false — сети нет, остальные записи пробовать бессмысленно. */
  private async attempt(e: OutboxEntry, report: FlushReport): Promise<boolean> {
    if (this.inFlight.has(e.opId)) return true;
    this.inFlight.add(e.opId);
    try {
      let res: SendResult;
      try {
        res = await this.send(e.request);
      } catch {
        await this.later(e);
        report.retry.push(e.opId);
        report.offline = true;
        return false;
      }
      const verdict = classify(res.status);
      if (verdict === 'sent') {
        await this.store.remove(e.opId);
        this.entries.delete(e.opId);
        this.lastFlush = this.now();
        await this.store.setMeta('lastFlushAt', String(this.lastFlush));
        report.sent.push(e.opId);
      } else if (verdict === 'rejected') {
        const code = res.code ?? (res.status === 404 ? 'not_found' : res.status === 403 ? 'forbidden' : 'bad_request');
        await this.store.putRejected({ opId: e.opId, userId: this.userId, title: e.title, code, at: this.now() });
        await this.store.remove(e.opId);
        this.entries.delete(e.opId);
        report.rejected.push({ opId: e.opId, code });
      } else {
        await this.later(e);
        report.retry.push(e.opId);
      }
      return true;
    } finally {
      this.inFlight.delete(e.opId);
      this.onChange();
    }
  }

  private async later(e: OutboxEntry): Promise<void> {
    const next: OutboxEntry = { ...e, attempts: e.attempts + 1 };
    next.retryAt = this.now() + backoffMs(next.attempts);
    await this.store.put(next);
    this.entries.set(next.opId, next);
  }

  rejectedList(): Promise<Array<{ opId: string; title: string; code: string; at: number }>> {
    return this.store.rejected(this.userId);
  }

  dismissRejected(opId: string): Promise<void> {
    return this.store.removeRejected(opId);
  }
}
