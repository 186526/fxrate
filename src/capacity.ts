// Phase 1 容量原语（capacity primitives）：供 mastercard/visa 等卡组织源在 Phase 2 集成时复用的
// 通用并发控制组件。全部为无依赖、可离线单测的纯 TS 模块，不引入任何运行时定时器。
//
// - CapacityError：稳定的容量错误（overload/closed/aborted），供调用方程序化区分。
// - KeyedSingleFlight：按 key 共享在途任务，任务 settle 后立即删除（成功/失败都不保留）；
//   等待者可用 AbortSignal 取消自己的等待，但绝不中止/拒绝其他等待者共享的任务。
// - BoundedExecutor：有界异步执行器（信号量）：limit 并发、有界 FIFO 队列、队列等待可取消、
//   稳定的 overload/closed/aborted 错误、close() 拒绝队列中任务、active/queued/rejected 计数可观测。
// - NegativeBackoffCache：有界负缓存/指数退避，用于 Card 类上游错误（401 未发布、403 WAF 拦截、
//   网络错误等）：短 TTL 起退避、连续失败按 factor 指数增长、成功即清除，时钟可注入以便确定性测试。
//
// 集成约定：native fetch 与 chromium 抓取各建一个独立的 BoundedExecutor 实例
// （见 AGENTS.md「mastercard/visa 取数实现」），避免 chromium 慢任务占满原生并发额度。

export type CapacityErrorCode = 'overload' | 'closed' | 'aborted';

const CAPACITY_ERROR_MESSAGES: Record<CapacityErrorCode, string> = {
    overload: 'capacity exceeded',
    closed: 'capacity closed',
    aborted: 'operation aborted',
};

/** 稳定的容量错误：code 供程序化区分，message 供日志/错误提示。 */
export class CapacityError extends Error {
    readonly code: CapacityErrorCode;

    constructor(code: CapacityErrorCode, message?: string) {
        super(message ?? CAPACITY_ERROR_MESSAGES[code]);
        this.name = 'CapacityError';
        this.code = code;
    }
}

// ---------- KeyedSingleFlight ----------

export class KeyedSingleFlight {
    private readonly inFlight = new Map<string, Promise<unknown>>();

    /**
     * 按 key 执行 factory；同一 key 的在途任务被所有调用者共享（factory 只执行一次）。
     * signal 只取消当前调用者的等待（以 aborted 拒绝该等待者），不会中止或拒绝共享任务本身。
     * 任务 settle（成功或失败）后立即从 map 删除，绝不保留已结束——尤其是已 reject——的任务。
     */
    run<T>(
        key: string,
        factory: () => Promise<T>,
        signal?: AbortSignal,
    ): Promise<T> {
        if (signal !== undefined && signal.aborted) {
            // 预中止的等待者不需要结果：不启动任务、不触碰 in-flight map。
            return Promise.reject(
                new CapacityError('aborted', 'single-flight wait aborted'),
            );
        }
        const existing = this.inFlight.get(key);
        if (existing !== undefined) {
            return this.awaitShared(existing as Promise<T>, signal);
        }

        let promise: Promise<T>;
        try {
            promise = Promise.resolve(factory());
        } catch (error) {
            promise = Promise.reject(error);
        }
        // finally 保证无论成功失败都在 settle 后删除 key（删除旧条目后新 run 才能建新任务）。
        const tracked = promise.finally(() => {
            this.inFlight.delete(key);
        });
        // 共享句柄自行吞掉 rejection，避免「所有等待者都已取消」时产生 unhandledRejection
        // （后端对 unhandledRejection 致命退出，见 src/index.ts）；等待者仍能观察到真实错误。
        tracked.catch(() => undefined);
        this.inFlight.set(key, tracked);
        return this.awaitShared(tracked, signal);
    }

    /** 当前在途（未 settle）的 key 数量。 */
    get size(): number {
        return this.inFlight.size;
    }

    private awaitShared<T>(
        promise: Promise<T>,
        signal?: AbortSignal,
    ): Promise<T> {
        if (signal === undefined) {
            return promise;
        }
        if (signal.aborted) {
            return Promise.reject(
                new CapacityError('aborted', 'single-flight wait aborted'),
            );
        }
        return new Promise<T>((resolve, reject) => {
            const onAbort = (): void => {
                reject(
                    new CapacityError('aborted', 'single-flight wait aborted'),
                );
            };
            signal.addEventListener('abort', onAbort, { once: true });
            promise.then(
                (value) => {
                    signal.removeEventListener('abort', onAbort);
                    resolve(value);
                },
                (error) => {
                    signal.removeEventListener('abort', onAbort);
                    reject(error);
                },
            );
        });
    }
}

// ---------- BoundedExecutor ----------

export interface BoundedExecutorOptions {
    /** 同时执行的任务数上限（正整数）。 */
    limit: number;
    /** 排队等待的任务数上限（非负整数）；0 = 不允许排队，满额直接 overload。 */
    queueSize: number;
}

interface QueueEntry<T> {
    task: () => Promise<T>;
    signal?: AbortSignal;
    onAbort?: () => void;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
}

export class BoundedExecutor {
    private readonly limit: number;
    private readonly queueSize: number;
    private readonly queue: QueueEntry<unknown>[] = [];
    private activeCount = 0;
    private rejectedTotal = 0;
    private closedFlag = false;

    constructor(options: BoundedExecutorOptions) {
        const { limit, queueSize } = options;
        if (!Number.isInteger(limit) || limit < 1) {
            throw new TypeError(
                `BoundedExecutor limit must be a positive integer, got ${String(limit)}`,
            );
        }
        if (!Number.isInteger(queueSize) || queueSize < 0) {
            throw new TypeError(
                `BoundedExecutor queueSize must be a non-negative integer, got ${String(queueSize)}`,
            );
        }
        this.limit = limit;
        this.queueSize = queueSize;
    }

    /** 当前执行中的任务数。 */
    get active(): number {
        return this.activeCount;
    }

    /** 当前排队等待的任务数（FIFO）。 */
    get queued(): number {
        return this.queue.length;
    }

    /** 累计被拒绝（overload/closed/aborted）的任务数，单调递增。 */
    get rejected(): number {
        return this.rejectedTotal;
    }

    get isClosed(): boolean {
        return this.closedFlag;
    }

    /**
     * 提交任务。signal 只取消排队等待（aborted 拒绝该任务），任务一旦开始执行即忽略 signal。
     * 满额时队列已满 → overload；close() 之后 → closed。
     */
    run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        if (this.closedFlag) {
            return this.rejectOnce(
                new CapacityError('closed', 'executor is closed'),
            );
        }
        if (signal !== undefined && signal.aborted) {
            return this.rejectOnce(
                new CapacityError(
                    'aborted',
                    'executor task aborted before start',
                ),
            );
        }
        if (this.activeCount < this.limit) {
            this.activeCount++;
            return this.execute(task);
        }
        if (this.queue.length >= this.queueSize) {
            return this.rejectOnce(
                new CapacityError('overload', 'executor queue is full'),
            );
        }
        return this.enqueue(task, signal);
    }

    /** 关闭执行器：拒绝所有排队任务（closed）；在途任务继续运行到结束，不再派发新任务。 */
    close(): void {
        if (this.closedFlag) return;
        this.closedFlag = true;
        while (this.queue.length > 0) {
            const entry = this.queue.shift()!;
            if (entry.signal !== undefined && entry.onAbort !== undefined) {
                entry.signal.removeEventListener('abort', entry.onAbort);
            }
            this.rejectedTotal++;
            entry.reject(new CapacityError('closed', 'executor closed'));
        }
    }

    private rejectOnce<T>(error: CapacityError): Promise<T> {
        this.rejectedTotal++;
        return Promise.reject(error);
    }

    private execute<T>(task: () => Promise<T>): Promise<T> {
        let promise: Promise<T>;
        try {
            promise = Promise.resolve(task());
        } catch (error) {
            promise = Promise.reject(error);
        }
        // 无论任务成功/失败，finally 都释放并发槽位并派发下一个排队任务。
        return promise.finally(() => {
            this.activeCount--;
            this.pump();
        });
    }

    private enqueue<T>(
        task: () => Promise<T>,
        signal?: AbortSignal,
    ): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const entry: QueueEntry<T> = {
                task,
                signal,
                onAbort: undefined,
                resolve,
                reject,
            };
            if (signal !== undefined) {
                entry.onAbort = () => {
                    this.removeQueued(entry);
                    this.rejectedTotal++;
                    reject(
                        new CapacityError(
                            'aborted',
                            'executor task cancelled while queued',
                        ),
                    );
                };
                signal.addEventListener('abort', entry.onAbort, { once: true });
            }
            this.queue.push(entry as QueueEntry<unknown>);
        });
    }

    private removeQueued<T>(entry: QueueEntry<T>): void {
        const index = this.queue.indexOf(entry as QueueEntry<unknown>);
        if (index >= 0) this.queue.splice(index, 1);
    }

    private pump(): void {
        while (
            !this.closedFlag &&
            this.activeCount < this.limit &&
            this.queue.length > 0
        ) {
            const entry = this.queue.shift()!;
            if (entry.signal !== undefined && entry.onAbort !== undefined) {
                entry.signal.removeEventListener('abort', entry.onAbort);
            }
            this.activeCount++;
            this.execute(entry.task).then(
                (value) => entry.resolve(value),
                (error) => entry.reject(error),
            );
        }
    }
}

// ---------- NegativeBackoffCache ----------

export interface BackoffClock {
    now(): number;
}

export interface NegativeBackoffOptions {
    /** 基础退避时长（毫秒），即首次失败的负缓存/退避窗口。 */
    ttlMs: number;
    /** 指数退避增长因子，默认 2；连续失败按 factor 逐级放大。 */
    factor?: number;
    /** 单次退避窗口上限（毫秒），默认 ttlMs * 60；若提供则必须是有限正数。 */
    maxDelayMs?: number;
    /** 记录条数上限（非负整数，0 = 禁用缓存），默认 10000；超限淘汰最早插入的条目。 */
    maxSize?: number;
    /** 可注入时钟（epoch ms），默认 Date.now；测试传入假时钟做确定性断言。 */
    clock?: BackoffClock;
}

export interface FailureRecord {
    /** 连续失败次数（自上次成功以来），驱动指数退避。 */
    attempts: number;
    /** 退避截止时间（epoch ms）；当前时间超过该值后 blocked() 返回 undefined。 */
    expiresAt: number;
    /** 最近一次失败的时间（epoch ms）。 */
    lastFailureAt: number;
    /** 最近一次失败的错误（由 recordFailure 传入，供调用方重抛/记录）。 */
    lastError?: unknown;
}

export class NegativeBackoffCache {
    private readonly records = new Map<string, FailureRecord>();
    private readonly ttlMs: number;
    private readonly factor: number;
    private readonly maxDelayMs: number;
    private readonly maxSize: number;
    private readonly clock: BackoffClock;
    private hitTotal = 0;
    private retryTotal = 0;

    constructor(options: NegativeBackoffOptions) {
        const {
            ttlMs,
            factor = 2,
            maxDelayMs,
            maxSize = 10000,
            clock,
        } = options;
        if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
            throw new TypeError(
                `NegativeBackoffCache ttlMs must be a positive number, got ${String(ttlMs)}`,
            );
        }
        if (!Number.isFinite(factor) || factor < 1) {
            throw new TypeError(
                `NegativeBackoffCache factor must be >= 1, got ${String(factor)}`,
            );
        }
        if (
            maxDelayMs !== undefined &&
            (!Number.isFinite(maxDelayMs) || maxDelayMs <= 0)
        ) {
            throw new TypeError(
                `NegativeBackoffCache maxDelayMs must be a positive number, got ${String(maxDelayMs)}`,
            );
        }
        if (!Number.isInteger(maxSize) || maxSize < 0) {
            throw new TypeError(
                `NegativeBackoffCache maxSize must be a non-negative integer, got ${String(maxSize)}`,
            );
        }
        this.ttlMs = ttlMs;
        this.factor = factor;
        this.maxDelayMs =
            maxDelayMs !== undefined ? Math.max(maxDelayMs, ttlMs) : ttlMs * 60;
        this.maxSize = maxSize;
        this.clock = clock ?? { now: () => Date.now() };
    }

    /**
     * 查询 key 是否处于退避期：未超时返回记录（并计数一次 hit），超时/不存在返回 undefined。
     * 不删除过期记录——下次 recordFailure 需依赖它继续累加 attempts 实现指数退避；
     * 内存上界由 maxSize 保证，成功（recordSuccess）即清除。
     */
    blocked(key: string): FailureRecord | undefined {
        const record = this.records.get(key);
        if (record === undefined) return undefined;
        if (record.expiresAt > this.clock.now()) {
            this.hitTotal++;
            return record;
        }
        return undefined;
    }

    /**
     * 记录一次失败：连续失败次数 +1，退避窗口 = min(ttlMs * factor^(attempts-1), maxDelayMs)，
     * 截止时间 = now + 窗口。返回更新后的记录。成功（recordSuccess）会清除记录并重置 attempts。
     */
    recordFailure(key: string, error?: unknown): FailureRecord {
        this.retryTotal++;
        const now = this.clock.now();
        const previous = this.records.get(key);
        const attempts = previous === undefined ? 1 : previous.attempts + 1;
        const delay = Math.min(
            this.ttlMs * Math.pow(this.factor, attempts - 1),
            this.maxDelayMs,
        );
        const record: FailureRecord = {
            attempts,
            expiresAt: now + delay,
            lastFailureAt: now,
            lastError: error,
        };
        this.records.set(key, record);
        this.evictIfNeeded();
        return record;
    }

    /** 记录一次成功：清除该 key 的负缓存条目；不存在时返回 false。 */
    recordSuccess(key: string): boolean {
        return this.records.delete(key);
    }

    /** 清空全部负缓存记录（不重置 hit/retry 计数）。 */
    clear(): void {
        this.records.clear();
    }

    /** 累计退避命中次数（blocked() 命中未过期记录），单调递增。 */
    get hitCount(): number {
        return this.hitTotal;
    }

    /** 累计失败记录次数（recordFailure 调用），单调递增。 */
    get retryCount(): number {
        return this.retryTotal;
    }

    /** 当前持有的记录条数。 */
    get size(): number {
        return this.records.size;
    }

    private evictIfNeeded(): void {
        while (this.records.size > this.maxSize) {
            const oldest = this.records.keys().next();
            if (oldest.done) break;
            this.records.delete(oldest.value);
        }
    }
}
