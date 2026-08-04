// Phase 2 刷新调度器（refresh scheduler）：把「每数据源独立 setInterval 30 分钟刷新」收敛为
// 全局有界调度——
//   - 稳定抖动（stable jitter）：每个 source 一个按名字确定性哈希的相位偏移（phase ∈
//     [0, jitterWindowMs)），跨重启/跨实例稳定，57 个源的首个刷新天然摊开在整个抖动窗口内，
//     避免旧实现全部源在注册时刻同时起表、每 30 分钟一次 thundering herd。
//   - 全局有界并发：所有刷新任务统一经 BoundedExecutor（src/capacity.ts）执行，limit 并发
//     上限 + 有界 FIFO 队列，绝不出现 57 个上游抓取同时打出去。
//   - 失败退避：刷新失败经 NegativeBackoffCache 指数退避（时钟可注入），退避期内定时器
//     tick 直接跳过（skipped），不再「每次请求都触发一次全量重抓」。
// 不变量：
//   - 每个 source 同一时刻至多一个刷新在途（inFlight 去重，配合 updateFXManager 单飞）；
//   - tick 与刷新结果解耦：tick 无论走哪条分支都以固定 intervalMs 重排下一次 tick；
//   - stop() 幂等：取消全部定时器 + 关闭执行器（拒绝排队任务），在途任务自然结束；
//     drain() 在 stop() 之后等待全部在途刷新 settle——停机落盘快照前必须等它，否则
//     在途刷新刚写回的新数据会被漏掉（与 fxmManager.stopAllInterval() 的停机契约配套）。
// 纯 TS、零公网依赖；退避时钟可注入（测试用假时钟做确定性断言），定时器用 Node setTimeout
// （可被 jest 假时钟控制）。所有毫秒参数（interval/jitter/backoff）都必须落在
// [1, NODE_TIMER_MAX_MS]（round 后）安全整数范围内——Node 对超出 2^31-1 的延迟会
// 静默转成 1ms，超限配置必须启动即抛错而不是运行时行为错误。

import {
    BoundedExecutor,
    CapacityError,
    NegativeBackoffCache,
} from './capacity';
import type { BackoffClock, FailureRecord } from './capacity';

export const DEFAULT_REFRESH_INTERVAL_MS = 30 * 60 * 1000;

// Node setTimeout 对延迟参数的安全上界：超过 2^31-1 会被静默当成 1ms（行为错误）。
// 一切直接/间接进定时器的毫秒参数（interval/jitter）都必须落在该范围内；
// backoff 延时虽不直接进定时器，同样约束到该上界保持数值语义一致。
export const NODE_TIMER_MAX_MS = 2_147_483_647;

/** 刷新周期最小合理值（round 后）：测试可注入 1ms，但 round 后为 0 的配置直接拒绝。 */
export const MIN_REFRESH_INTERVAL_MS = 1;

export const MAX_CONCURRENCY = 1024;
export const MAX_QUEUE_SIZE = 1_000_000;
export const MAX_BACKOFF_MAX_SIZE = 1_000_000;

export interface RefreshSchedulerConfig {
    /** 基础刷新周期（毫秒），默认 30 分钟；可被环境变量 FXRATE_REFRESH_INTERVAL_MS 覆盖。 */
    intervalMs?: number;
    /** 抖动窗口（毫秒）：source 相位落在 [0, jitterWindowMs)，默认 = intervalMs。 */
    jitterWindowMs?: number;
    /** 全局并发刷新上限，默认 4。 */
    concurrency?: number;
    /** 执行器排队上限（有界），默认 128。 */
    queueSize?: number;
    /** 退避基础 TTL（毫秒），默认 60s。 */
    backoffTtlMs?: number;
    /** 退避增长因子，默认 2。 */
    backoffFactor?: number;
    /** 退避窗口上限（毫秒），默认 = intervalMs（失败源至多每个周期尝试一次）。 */
    backoffMaxDelayMs?: number;
    /** 退避记录条数上限，默认 10000。 */
    backoffMaxSize?: number;
    /** 可注入时钟（退避判定），测试传假时钟做确定性断言。 */
    clock?: BackoffClock;
    /** 日志回调（可选）。 */
    logger?: (message: string) => void;
}

export interface RefreshSchedulerOptions extends RefreshSchedulerConfig {
    /** 实际刷新动作（fxmManager.updateFXManager）。 */
    refreshFn: (source: string) => Promise<void>;
    /** 每次（重）排定时器后的回调：fxmManager 用它维护 intervalIDs[source].timeout 句柄。 */
    onSchedule?: (source: string, timer: NodeJS.Timeout) => void;
}

// FNV-1a 32 位哈希：确定性、零依赖，source 名 → [0, 2^32)。
function stableHash(input: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

function envPositiveInt(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    return Number.isInteger(value) && value > 0 && value <= NODE_TIMER_MAX_MS
        ? value
        : fallback;
}

export class RefreshScheduler {
    private readonly refreshFn: (source: string) => Promise<void>;
    private readonly onSchedule?: (
        source: string,
        timer: NodeJS.Timeout,
    ) => void;
    private readonly intervalMs: number;
    private readonly jitterWindowMs: number;
    private readonly logger?: (message: string) => void;
    private readonly executor: BoundedExecutor;
    private readonly backoff: NegativeBackoffCache;
    private readonly timers = new Map<string, NodeJS.Timeout>();
    private readonly inFlight = new Set<string>();
    private readonly drainWaiters: (() => void)[] = [];
    private stoppedFlag = false;
    private refreshTotal = 0;
    private successTotal = 0;
    private failureTotal = 0;
    private skippedTotal = 0;

    constructor(options: RefreshSchedulerOptions) {
        const {
            refreshFn,
            onSchedule,
            intervalMs = envPositiveInt(
                'FXRATE_REFRESH_INTERVAL_MS',
                DEFAULT_REFRESH_INTERVAL_MS,
            ),
            jitterWindowMs,
            concurrency = 4,
            queueSize = 128,
            backoffTtlMs = 60_000,
            backoffFactor = 2,
            backoffMaxDelayMs,
            backoffMaxSize = 10_000,
            clock,
            logger,
        } = options;
        const roundedInterval = Math.round(intervalMs);
        if (
            !Number.isFinite(intervalMs) ||
            roundedInterval < MIN_REFRESH_INTERVAL_MS ||
            roundedInterval > NODE_TIMER_MAX_MS
        ) {
            throw new TypeError(
                `RefreshScheduler intervalMs must be a positive number that rounds to at least ${MIN_REFRESH_INTERVAL_MS} and at most ${NODE_TIMER_MAX_MS}, got ${String(intervalMs)}`,
            );
        }
        const window = jitterWindowMs ?? intervalMs;
        const roundedWindow = Math.round(window);
        if (
            !Number.isFinite(window) ||
            window < 0 ||
            roundedWindow > NODE_TIMER_MAX_MS
        ) {
            throw new TypeError(
                `RefreshScheduler jitterWindowMs must be a non-negative number at most ${NODE_TIMER_MAX_MS}, got ${String(window)}`,
            );
        }
        if (
            !Number.isInteger(concurrency) ||
            concurrency < 1 ||
            concurrency > MAX_CONCURRENCY
        ) {
            throw new TypeError(
                `RefreshScheduler concurrency must be an integer in [1, ${MAX_CONCURRENCY}], got ${String(concurrency)}`,
            );
        }
        if (
            !Number.isInteger(queueSize) ||
            queueSize < 0 ||
            queueSize > MAX_QUEUE_SIZE
        ) {
            throw new TypeError(
                `RefreshScheduler queueSize must be an integer in [0, ${MAX_QUEUE_SIZE}], got ${String(queueSize)}`,
            );
        }
        if (
            !Number.isFinite(backoffTtlMs) ||
            backoffTtlMs <= 0 ||
            backoffTtlMs > NODE_TIMER_MAX_MS
        ) {
            throw new TypeError(
                `RefreshScheduler backoffTtlMs must be a positive number at most ${NODE_TIMER_MAX_MS}, got ${String(backoffTtlMs)}`,
            );
        }
        if (
            backoffMaxDelayMs !== undefined &&
            (!Number.isFinite(backoffMaxDelayMs) ||
                backoffMaxDelayMs <= 0 ||
                backoffMaxDelayMs > NODE_TIMER_MAX_MS)
        ) {
            throw new TypeError(
                `RefreshScheduler backoffMaxDelayMs must be a positive number at most ${NODE_TIMER_MAX_MS}, got ${String(backoffMaxDelayMs)}`,
            );
        }
        if (!Number.isFinite(backoffFactor) || backoffFactor < 1) {
            throw new TypeError(
                `RefreshScheduler backoffFactor must be >= 1, got ${String(backoffFactor)}`,
            );
        }
        if (
            !Number.isInteger(backoffMaxSize) ||
            backoffMaxSize < 0 ||
            backoffMaxSize > MAX_BACKOFF_MAX_SIZE
        ) {
            throw new TypeError(
                `RefreshScheduler backoffMaxSize must be an integer in [0, ${MAX_BACKOFF_MAX_SIZE}], got ${String(backoffMaxSize)}`,
            );
        }
        this.refreshFn = refreshFn;
        this.onSchedule = onSchedule;
        this.intervalMs = roundedInterval;
        this.jitterWindowMs = roundedWindow;
        this.logger = logger;
        this.executor = new BoundedExecutor({ limit: concurrency, queueSize });
        this.backoff = new NegativeBackoffCache({
            ttlMs: backoffTtlMs,
            factor: backoffFactor,
            maxDelayMs: backoffMaxDelayMs ?? this.intervalMs,
            maxSize: backoffMaxSize,
            clock,
        });
    }

    /** 基础刷新周期（毫秒）。 */
    get interval(): number {
        return this.intervalMs;
    }

    /** 基础刷新周期（秒，至少 1），供 Cache-Control max-age 计算。 */
    get intervalSecs(): number {
        return Math.max(1, Math.round(this.intervalMs / 1000));
    }

    /** source 的稳定相位（毫秒，落在 [0, jitterWindowMs)）。跨实例/重启确定。 */
    phaseOf(source: string): number {
        if (this.jitterWindowMs <= 0) return 0;
        return stableHash(source) % this.jitterWindowMs;
    }

    /** 当前排了定时器的 source 数（stop() 后为 0）。 */
    get timerCount(): number {
        return this.timers.size;
    }

    get isStopped(): boolean {
        return this.stoppedFlag;
    }

    /** 已启动（进入执行器）的刷新总数。 */
    get refreshCount(): number {
        return this.refreshTotal;
    }

    get successCount(): number {
        return this.successTotal;
    }

    /** 刷新动作真实失败（非执行器过载/关闭）的次数。 */
    get failureCount(): number {
        return this.failureTotal;
    }

    /** 因退避/在途而跳过的 tick 次数。 */
    get skippedCount(): number {
        return this.skippedTotal;
    }

    /** 执行器当前在途任务数。 */
    get active(): number {
        return this.executor.active;
    }

    /** 执行器当前排队任务数。 */
    get queued(): number {
        return this.executor.queued;
    }

    // —— 退避透传（fxmManager 在 updateFXManager 成功/失败时调用同一实例）——

    /** source 是否处于退避期；未超时返回记录并计一次 hit，超时/不存在返回 undefined。 */
    blocked(source: string): FailureRecord | undefined {
        return this.backoff.blocked(source);
    }

    recordFailure(source: string, error?: unknown): FailureRecord {
        return this.backoff.recordFailure(source, error);
    }

    recordSuccess(source: string): boolean {
        return this.backoff.recordSuccess(source);
    }

    get backoffSize(): number {
        return this.backoff.size;
    }

    get backoffHitCount(): number {
        return this.backoff.hitCount;
    }

    get backoffRetryCount(): number {
        return this.backoff.retryCount;
    }

    /** 注册一个 source 并按稳定相位排入首个刷新 tick；重复注册幂等。 */
    register(source: string): void {
        if (this.stoppedFlag) return;
        if (this.timers.has(source)) return;
        this.schedule(source, this.phaseOf(source));
    }

    /** 停机：取消全部定时器、关闭执行器（拒绝排队任务，在途自然结束）。幂等。 */
    stop(): void {
        if (this.stoppedFlag) return;
        this.stoppedFlag = true;
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
        this.executor.close();
    }

    /**
     * 停机等待：全部在途刷新 settle 后 resolve。必须与 stop() 搭配使用——
     * stop() 取消定时器并关闭执行器后，已启动的刷新仍在途，drain() 等它们
     * 自然结束；停机落盘快照前必须等待，否则在途刷新刚写回的新数据会被漏掉。
     * 无在途刷新时立即 resolve。
     */
    drain(): Promise<void> {
        if (this.inFlight.size === 0) return Promise.resolve();
        return new Promise((resolve) => {
            this.drainWaiters.push(resolve);
        });
    }

    private notifyDrain(): void {
        if (this.inFlight.size !== 0) return;
        const waiters = this.drainWaiters.splice(0);
        for (const waiter of waiters) waiter();
    }

    private schedule(source: string, delayMs: number): void {
        if (this.stoppedFlag) return;
        const timer = setTimeout(() => this.onTick(source), delayMs);
        this.timers.set(source, timer);
        this.onSchedule?.(source, timer);
    }

    private onTick(source: string): void {
        this.timers.delete(source);
        if (this.stoppedFlag) return;
        // 无论刷新是否执行/成功/跳过，都以固定周期重排下一次（与旧 setInterval 语义一致）。
        this.schedule(source, this.intervalMs);
        // 上一轮刷新仍在途：不排队、不重复启动，保持同一节奏等它完成。
        if (this.inFlight.has(source)) {
            this.skippedTotal++;
            return;
        }
        // 退避期内：跳过本次 tick，等退避窗口过了再由下一个 tick 重试。
        if (this.backoff.blocked(source) !== undefined) {
            this.skippedTotal++;
            this.log(`${source} refresh skipped (backoff)`);
            return;
        }
        this.refreshTotal++;
        this.inFlight.add(source);
        this.executor
            .run(() => this.refreshFn(source))
            .then(() => {
                this.successTotal++;
            })
            .catch((error: unknown) => {
                if (error instanceof CapacityError) {
                    // 执行器过载/已关闭：刷新根本没启动，不计入源失败。
                    this.skippedTotal++;
                } else {
                    this.failureTotal++;
                }
            })
            .finally(() => {
                this.inFlight.delete(source);
                this.notifyDrain();
            });
    }

    private log(message: string): void {
        this.logger?.(`[refreshScheduler] ${message}`);
    }
}
