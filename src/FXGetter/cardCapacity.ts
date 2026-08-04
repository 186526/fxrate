// Phase 1 Card 协调层（card capacity coordination）：mastercard/visa 共用的取数编排。
//
// 责任：
// - 共享一个 native BoundedExecutor（limit 8，见 CARD_NATIVE_EXECUTOR），mastercard 与
//   visa 的原生 fetch 路径都经它调度，避免卡组织请求无界并发互相挤占。
// - visa 的 headless chromium 降级单独一个 executor（limit 1，见 CARD_CHROMIUM_EXECUTOR），
//   与 native 分池——chromium 慢任务不占原生并发额度。
// - 取数顺序固定：正 LRU → 负缓存 blocked → keyed single-flight；single-flight 的 factory
//   重查两个缓存后才经相关 executor 跑完整 7 日工作流。
// - 成功：validate → 写正缓存 → recordSuccess；最终上游失败：recordFailure 后 rethrow；
//   CapacityError（overload/closed/aborted）绝不写入负缓存——重试仍有机会。
//
// 集成约定：各卡源（mastercard.ts/visa.ts）构造自己的 CardCoordinator，正缓存 LRU 由各源
// 持有（max 500 / ttl 30m），executor 默认用本模块共享单例；测试可用覆盖参数注入小容量
// executor 与假时钟做确定性断言，也可直接断言两个源的 coordinator 引用同一 native 实例。

import { LRUCache } from 'lru-cache';

import {
    BoundedExecutor,
    CapacityError,
    KeyedSingleFlight,
    NegativeBackoffCache,
    type FailureRecord,
} from '../capacity';
import {
    metricClockSeconds,
    metricElapsedSeconds,
    observeSourceFetch,
    recordCacheHit,
} from '../metrics';

/** 卡组织原生 fetch 共享 executor：limit 8，bounded FIFO 队列 512。 */
export const CARD_NATIVE_EXECUTOR = new BoundedExecutor({
    limit: 8,
    queueSize: 512,
    metricsLabel: 'card_native',
});

/** 卡组织 headless chromium 降级 executor（visa 专用）：limit 1，bounded FIFO 队列 32。 */
export const CARD_CHROMIUM_EXECUTOR = new BoundedExecutor({
    limit: 1,
    queueSize: 32,
    metricsLabel: 'card_chromium',
});

/** 负缓存默认参数：10s 起、x2 指数退避、单窗口上限 60s、最多 500 条。 */
export const CARD_NEGATIVE_TTL_MS = 10_000;
export const CARD_NEGATIVE_FACTOR = 2;
export const CARD_NEGATIVE_MAX_DELAY_MS = 60_000;
export const CARD_NEGATIVE_MAX_SIZE = 500;

/** 默认负缓存实例（测试可另建并注入假时钟做确定性退避断言）。 */
export function createCardNegativeCache(): NegativeBackoffCache {
    return new NegativeBackoffCache({
        ttlMs: CARD_NEGATIVE_TTL_MS,
        factor: CARD_NEGATIVE_FACTOR,
        maxDelayMs: CARD_NEGATIVE_MAX_DELAY_MS,
        maxSize: CARD_NEGATIVE_MAX_SIZE,
    });
}

export interface CardCoordinatorOptions<TPayload> {
    /** 参与归一化 single-flight/负缓存 key 的源名（如 'mastercard' / 'visa'）。 */
    source: string;
    /** 正缓存：各源持有的 LRU（max 500 / ttl 30m），key 为 `from+to`（已归一化）。 */
    positive: LRUCache<string, string>;
    /** 负缓存/指数退避实例（默认参数见 createCardNegativeCache，测试可注入假时钟）。 */
    negative: NegativeBackoffCache;
    /** 货币归一化（CNH → CNY），正缓存 key 与 single-flight key 共用同一规则。 */
    normalize: (code: string) => string;
    /** 完整 7 日回退工作流（native fetch 路径），经 native executor 调度。 */
    nativeWorkflow: (from: string, to: string) => Promise<TPayload>;
    /** 可选 chromium 降级工作流（visa 专用），经 chromium executor 调度；native 容量错误不触发。 */
    chromiumWorkflow?: (from: string, to: string) => Promise<TPayload>;
    /** 写正缓存前的最终校验；不合法抛错（该失败同样计入负缓存）。 */
    validate: (payload: TPayload) => void;
    /** payload → 正缓存 LRU 字符串（如 JSON.stringify）。 */
    serialize: (payload: TPayload) => string;
    /** 测试注入：覆盖共享 executors（默认 CARD_NATIVE_EXECUTOR / CARD_CHROMIUM_EXECUTOR）。 */
    nativeExecutor?: BoundedExecutor;
    chromiumExecutor?: BoundedExecutor;
}

export class CardCoordinator<TPayload> {
    private readonly options: CardCoordinatorOptions<TPayload>;
    private readonly singleFlight = new KeyedSingleFlight();

    /** 实际使用的 native executor（默认共享单例，测试可断言跨源共享）。 */
    readonly nativeExecutor: BoundedExecutor;
    /** 实际使用的 chromium executor（无 chromiumWorkflow 时为 undefined）。 */
    readonly chromiumExecutor: BoundedExecutor | undefined;

    constructor(options: CardCoordinatorOptions<TPayload>) {
        this.options = options;
        this.nativeExecutor = options.nativeExecutor ?? CARD_NATIVE_EXECUTOR;
        this.chromiumExecutor =
            options.chromiumExecutor ??
            (options.chromiumWorkflow !== undefined
                ? CARD_CHROMIUM_EXECUTOR
                : undefined);
    }

    /** 当前 single-flight 在途 key 数（可观测/测试）。 */
    get inFlight(): number {
        return this.singleFlight.size;
    }

    /** 正缓存（测试断言用）。 */
    get positive(): LRUCache<string, string> {
        return this.options.positive;
    }

    /** 负缓存（测试断言用）。 */
    get negative(): NegativeBackoffCache {
        return this.options.negative;
    }

    /**
     * 有序取数，三步：
     *  1. 正 LRU 命中直接返回；
     *  2. 负缓存 blocked 直接抛最近一次失败（不触发任何上游工作）；
     *  3. 否则经 keyed single-flight 共享同一工作流——factory 内先重查两个缓存，
     *     再经相关 executor 跑完整 7 日工作流（mastercard 只有 native；visa 失败后降级 chromium）。
     */
    async get(from: string, to: string, signal?: AbortSignal): Promise<void> {
        const key = this.keyOf(from, to);
        const cacheKey = this.cacheKey(from, to);

        if (this.options.positive.has(cacheKey)) {
            recordCacheHit('card_positive', this.options.source);
            return;
        }
        const blocked = this.options.negative.blocked(key);
        if (blocked !== undefined) {
            recordCacheHit('card_negative', this.options.source);
            throw this.blockedError(blocked);
        }

        await this.singleFlight.run(
            key,
            async () => {
                // factory 重查两个缓存：同一归一化 key 可能已被并发路径填充/退避。
                if (this.options.positive.has(cacheKey)) {
                    recordCacheHit('card_positive', this.options.source);
                    return;
                }
                const reblocked = this.options.negative.blocked(key);
                if (reblocked !== undefined) {
                    recordCacheHit('card_negative', this.options.source);
                    throw this.blockedError(reblocked);
                }

                try {
                    const payload = await this.runWorkflow(from, to);
                    this.options.validate(payload);
                    this.options.positive.set(
                        cacheKey,
                        this.options.serialize(payload),
                    );
                    this.options.negative.recordSuccess(key);
                } catch (error) {
                    // 容量错误（overload/closed/aborted）不污染负缓存。
                    if (!(error instanceof CapacityError)) {
                        this.options.negative.recordFailure(key, error);
                    }
                    throw error;
                }
            },
            signal,
        );
    }

    private keyOf(from: string, to: string): string {
        return `${this.options.source}:${this.options.normalize(from)}:${this.options.normalize(to)}`;
    }

    private cacheKey(from: string, to: string): string {
        return `${this.options.normalize(from)}${this.options.normalize(to)}`;
    }

    /** 完整工作流经相关 executor 调度：native 失败（非容量错误）且配置了 chromium 时降级。 */
    private async runWorkflow(from: string, to: string): Promise<TPayload> {
        try {
            return await this.nativeExecutor.run(async () => {
                const startedAt = metricClockSeconds();
                try {
                    return await this.options.nativeWorkflow(from, to);
                } finally {
                    observeSourceFetch(
                        this.options.source,
                        metricElapsedSeconds(startedAt),
                    );
                }
            });
        } catch (nativeError) {
            const chromiumWorkflow = this.options.chromiumWorkflow;
            if (
                nativeError instanceof CapacityError ||
                chromiumWorkflow === undefined ||
                this.chromiumExecutor === undefined
            ) {
                throw nativeError;
            }
            try {
                return await this.chromiumExecutor.run(async () => {
                    const startedAt = metricClockSeconds();
                    try {
                        return await chromiumWorkflow(from, to);
                    } finally {
                        observeSourceFetch(
                            this.options.source,
                            metricElapsedSeconds(startedAt),
                        );
                    }
                });
            } catch (chromiumError) {
                if (chromiumError instanceof CapacityError) {
                    throw chromiumError;
                }
                const nativeMessage =
                    nativeError instanceof Error
                        ? nativeError.message
                        : String(nativeError);
                const chromiumMessage =
                    chromiumError instanceof Error
                        ? chromiumError.message
                        : String(chromiumError);
                throw new Error(
                    `native error: ${nativeMessage}; chromium fallback failed: ${chromiumMessage}`,
                );
            }
        }
    }

    private blockedError(record: FailureRecord): Error {
        if (record.lastError instanceof Error) {
            return record.lastError;
        }
        return new Error('upstream failure cached in negative cache');
    }
}
