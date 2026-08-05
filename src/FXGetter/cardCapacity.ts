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
//
// Phase 5 扩展（sparse typed cache）：正缓存 LRU 从「JSON 字符串」升级为「类型化 CardRate」
// （middle/cash/remit 为 mathjs Fraction、updated 为 Date）——上游响应在写缓存时一次性
// 解析，字段读取零 JSON.parse；同时提供 createCardSparseMatrix 替代各源的全量 N×N Proxy
// 矩阵（行/单元格按需物化，绝不全量物化 51k 单元格），对外契约（Object.keys / in /
// truthiness）与原矩阵一致。

import type { Fraction } from 'mathjs';
import { LRUCache } from 'lru-cache';

import type { FXRateType } from '../fxm/fxManager';

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

// ---------- 稀疏类型化正缓存（Phase 5）----------

/** 卡组织单对已解析类型化报价：middle/cash/remit 为 mathjs Fraction、updated 为 Date。 */
export interface CardRate {
    middle: Fraction;
    cash: Fraction;
    remit: Fraction;
    updated: Date;
}

/** 稀疏矩阵物化计数（测试/基准可观测：稀疏实现绝不全量物化 51k 单元格）。 */
export interface CardSparseStats {
    rows: number;
    cells: number;
}

/**
 * 创建单对 live 单元格工厂：单元格字段读取实时解析自 typed 正缓存。
 * 4 个 accessor 为「每缓存一次」的共享 getter（经 this.__cardKey 读 key），
 * 单元格自身只保存 key——逐 cell 闭包会让 4 个 accessor 变成 N 份闭包（实测
 * 28k cell 堆 45.9MB → 共享 getter 后 1.6MB）。无 Proxy、无 JSON.parse，
 * 未缓存或被淘汰时字段为 undefined（与旧 Proxy 语义一致）。
 */
export function createCardRateCellFactory(
    cache: LRUCache<string, CardRate>,
): (key: string) => FXRateType {
    const readMiddle = function (this: CardRateCellView): unknown {
        return cache.get(this.__cardKey)?.middle;
    };
    const readCash = function (this: CardRateCellView): unknown {
        return cache.get(this.__cardKey)?.cash;
    };
    const readRemit = function (this: CardRateCellView): unknown {
        return cache.get(this.__cardKey)?.remit;
    };
    const readUpdated = function (this: CardRateCellView): unknown {
        return cache.get(this.__cardKey)?.updated;
    };
    return function cellForKey(key: string): FXRateType {
        const cell: CardRateCellView = {};
        Object.defineProperties(cell, {
            __cardKey: { value: key, writable: true, configurable: true },
            middle: { enumerable: true, get: readMiddle },
            cash: { enumerable: true, get: readCash },
            remit: { enumerable: true, get: readRemit },
            updated: { enumerable: true, get: readUpdated },
        });
        return cell as unknown as FXRateType;
    };
}

/** 单元格内部视图：__cardKey 非枚举，Object.keys 只暴露 4 个报价字段。 */
interface CardRateCellView {
    __cardKey?: string;
    middle?: Fraction;
    cash?: Fraction;
    remit?: Fraction;
    updated?: Date;
}

/**
 * 创建稀疏卡组织汇率表（替代 Phase 1 的全量 N×N Proxy 矩阵）。
 * 行/单元格按需物化：`[from]` 首次访问才建行、`[to]` 首次访问才建单元格；未访问的
 * pair 不占对象。单元格 key 按 `normalize(from)+normalize(to)` 对齐 coordinator 正缓存。
 * 对外契约与原矩阵一致：Object.keys 返回全部支持货币（源信息 / BFS 邻居枚举）、
 * `in` 与 truthiness 对任意支持货币成立（getFXPath 直连判定不触发物化）。
 */
export function createCardSparseMatrix(
    currencies: readonly string[],
    cache: LRUCache<string, CardRate>,
    normalize: (code: string) => string,
    stats?: CardSparseStats,
): { [from: string]: { [to: string]: FXRateType } } {
    const rows: { [from: string]: { [to: string]: FXRateType } } = {};
    const cellForKey = createCardRateCellFactory(cache);

    const makeCell = (from: string, to: string): FXRateType => {
        if (stats !== undefined) stats.cells++;
        return cellForKey(`${normalize(from)}${normalize(to)}`);
    };

    const makeRow = (from: string): { [to: string]: FXRateType } => {
        const row = {} as { [to: string]: FXRateType };
        return new Proxy(row, {
            get: (target, prop) => {
                if (typeof prop !== 'string') return undefined;
                if (Object.prototype.hasOwnProperty.call(target, prop)) {
                    return target[prop];
                }
                if (!currencies.includes(prop)) return undefined;
                const cell = makeCell(from, prop);
                target[prop] = cell;
                return cell;
            },
            has: (_target, prop) =>
                typeof prop === 'string' && currencies.includes(prop),
            ownKeys: () => [...currencies],
            getOwnPropertyDescriptor: (_target, prop) => {
                if (typeof prop === 'string' && currencies.includes(prop)) {
                    return {
                        configurable: true,
                        enumerable: true,
                        writable: true,
                        value: undefined,
                    };
                }
                return undefined;
            },
        });
    };

    return new Proxy(rows, {
        get: (target, prop) => {
            if (typeof prop !== 'string') return undefined;
            if (Object.prototype.hasOwnProperty.call(target, prop)) {
                return target[prop];
            }
            if (!currencies.includes(prop)) return undefined;
            if (stats !== undefined) stats.rows++;
            const row = makeRow(prop);
            target[prop] = row;
            return row;
        },
        has: (_target, prop) =>
            typeof prop === 'string' && currencies.includes(prop),
        ownKeys: () => [...currencies],
        getOwnPropertyDescriptor: (_target, prop) => {
            if (typeof prop === 'string' && currencies.includes(prop)) {
                return {
                    configurable: true,
                    enumerable: true,
                    writable: true,
                    value: undefined,
                };
            }
            return undefined;
        },
    });
}

export interface CardCoordinatorOptions<TPayload, TStored = TPayload> {
    /** 参与归一化 single-flight/负缓存 key 的源名（如 'mastercard' / 'visa'）。 */
    source: string;
    /** 正缓存：各源持有的 LRU（max 500 / ttl 30m），key 为 `from+to`（已归一化）。 */
    positive: LRUCache<string, TStored>;
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
    /** payload → 正缓存 LRU 存储值（如 CardRate 类型化值；旧实现为 JSON 字符串）。 */
    serialize: (payload: TPayload) => TStored;
    /** 测试注入：覆盖共享 executors（默认 CARD_NATIVE_EXECUTOR / CARD_CHROMIUM_EXECUTOR）。 */
    nativeExecutor?: BoundedExecutor;
    chromiumExecutor?: BoundedExecutor;
}

export class CardCoordinator<TPayload, TStored = TPayload> {
    private readonly options: CardCoordinatorOptions<TPayload, TStored>;
    private readonly singleFlight = new KeyedSingleFlight();

    /** 实际使用的 native executor（默认共享单例，测试可断言跨源共享）。 */
    readonly nativeExecutor: BoundedExecutor;
    /** 实际使用的 chromium executor（无 chromiumWorkflow 时为 undefined）。 */
    readonly chromiumExecutor: BoundedExecutor | undefined;

    constructor(options: CardCoordinatorOptions<TPayload, TStored>) {
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
    get positive(): LRUCache<string, TStored> {
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
