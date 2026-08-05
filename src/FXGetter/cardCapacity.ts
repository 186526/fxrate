// Phase 1 Card 协调层（card capacity coordination）：mastercard/visa 共用的取数编排。
//
// 责任：
// - 共享一个 native BoundedExecutor（limit 8，见 CARD_NATIVE_EXECUTOR），mastercard 与
//   visa 的原生 fetch 路径都经它调度，避免卡组织请求无界并发互相挤占。
// - visa 的 headless chromium 降级单独一个 executor（limit 1，见 CARD_CHROMIUM_EXECUTOR），
//   与 native 分池——chromium 慢任务不占原生并发额度。
// - 取数顺序固定：正 LRU → 负缓存 blocked → keyed single-flight；single-flight 的 factory
//   重查两个缓存后才经相关 executor 跑完整 7 日工作流。
// - 成功：payload 校验 → serialize → 存储值最终校验（validateStored，见下）→ 写正缓存 →
//   recordSuccess；最终上游失败：recordFailure 后 rethrow；CapacityError（overload/closed/
//   aborted）绝不写入负缓存——重试仍有机会。
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
//
// Phase 5 评审修复（review remediation）：
// - 单元格恢复旧密集 Proxy cell 的反射/读取语义：单元格是「仅 get trap 的 Proxy over
//   {}」，get trap 忽略 target 上的赋值——自定义/符号/非报价字段读取恒为 undefined（赋值
//   只经 Object.keys / descriptor 可见），报价字段恒读缓存（赋值不覆盖读取），仅「非可写
//   非配置数据属性」的不变式例外返回精确值；key 存 WeakMap（target 保持裸 {}）。
// - 读取克隆：middle/cash/remit 每次读取返回新 Fraction、updated 返回新 Date——旧密集
//   实现每字段 JSON.parse + 新建也是新对象，此修复恢复该语义，杜绝消费方改动缓存值。
// - 矩阵/行 Proxy 恢复普通对象语义并加固不变式：继承属性（toString/constructor 等）委托
//   Reflect；delete 支持货币后 get/has/ownKeys 全部省略直到 set/defineProperty 恢复
//   （deleted 集合）；preventExtensions/seal/freeze 先一次性物化全部未删除支持货币再反射
//   防扩展——Object.keys 保持全量（与旧密集矩阵一致）且不违反 ownKeys/描述符不变式；
//   非可写非配置数据属性的 get/set 不变式返回精确值/拒绝。
// - 最终校验门（validateStored）：serialize 之后的存储值先经 validateCardRate 把关——
//   报价必须为有限正 Fraction、updated 必须是合法且非未来的 Date（允许 CARD_RATE_FUTURE_
//   SKEW_MS 时钟偏差）；畸形 payload（含缺失/非法时间戳，visa 的 lastUpdatedVisaRate、
//   mastercard 的 fxDate）抛错进入负缓存、绝不写正缓存。
// - 默认稀疏回退旗标：FXRATE_CARD_DENSE_MATRIX=1 时 createCardMatrix 构建全量 N×N typed
//   密集矩阵（行/格一次性物化，单元格仍是 live typed 克隆视图），默认环境走稀疏实现。

import { fraction, isFraction, type Fraction } from 'mathjs';
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
 * 克隆 Fraction（mathjs 的 fraction(existing) 返回同一引用，必须按 s/n/d 重建新实例）。
 * 非法/非有限值（NaN/Infinity/非正分母）视为未缓存返回 undefined。
 */
function cloneFraction(value: Fraction | undefined): Fraction | undefined {
    if (
        value === undefined ||
        !Number.isFinite(value.s) ||
        !Number.isFinite(value.n) ||
        !Number.isFinite(value.d) ||
        value.d <= 0
    ) {
        return undefined;
    }
    return fraction(value.s * value.n, value.d);
}

/** 克隆 Date：每次读取返回新实例，调用方 setTime 等改动不会污染缓存。 */
function cloneDate(value: Date | undefined): Date | undefined {
    if (value === undefined || Number.isNaN(value.getTime())) {
        return undefined;
    }
    return new Date(value.getTime());
}

/**
 * 创建单对 live 单元格工厂：单元格字段读取实时解析自 typed 正缓存，且每次返回克隆
 * （Fraction/Date 新实例，杜绝调用方改动缓存值）。单元格是「仅 get trap 的 Proxy over
 * 空对象」——与旧全量密集矩阵的 Proxy cell 反射语义完全一致：get trap 忽略 target 上的
 * 赋值——自定义/符号/非报价字段读取恒为 undefined（即使已赋值，赋值只经 Object.keys /
 * getOwnPropertyDescriptor 可见），middle/cash/remit/updated 恒读缓存（赋值不覆盖读取）；
 * 仅「非可写非配置数据属性」的不变式例外须返回精确值。Object.keys / getOwnPropertyNames /
 * JSON.stringify / 展开随 target 真实自有键（赋值/defineProperty 可见，报价字段未赋值时
 * 为空对象）；key 经 WeakMap 挂 target。handler 为「每缓存一次」的共享单例（不逐 cell
 * 建闭包）；未缓存或被淘汰时字段为 undefined。
 */
export function createCardRateCellFactory(
    cache: LRUCache<string, CardRate>,
): (key: string) => FXRateType {
    const keyOf = new WeakMap<object, string>();
    const handler: ProxyHandler<Record<PropertyKey, unknown>> = {
        get(target, prop) {
            // Proxy 不变式：非可写非配置数据属性必须返回精确值（old dense 同规则）。
            const own = Object.getOwnPropertyDescriptor(target, prop);
            if (
                own !== undefined &&
                own.configurable === false &&
                'value' in own &&
                own.writable === false
            ) {
                return own.value;
            }
            if (typeof prop !== 'string') return undefined;
            const cached = cache.get(keyOf.get(target) as string);
            switch (prop) {
                case 'middle':
                    return cloneFraction(cached?.middle);
                case 'cash':
                    return cloneFraction(cached?.cash);
                case 'remit':
                    return cloneFraction(cached?.remit);
                case 'updated':
                    return cloneDate(cached?.updated);
                default:
                    return undefined;
            }
        },
    };
    return function cellForKey(key: string): FXRateType {
        const target: Record<PropertyKey, unknown> = {};
        keyOf.set(target, key);
        return new Proxy(target, handler) as unknown as FXRateType;
    };
}

/**
 * 稀疏 Proxy 层（矩阵层/行层共用）：行/单元格按需物化——get trap 首次访问才调 factory 并
 * 落到 target；未访问的 pair 不占对象。对外契约与原全量密集矩阵（普通对象）一致：
 * Object.keys 返回全部支持货币（getFXPath 的 BFS 邻居枚举不触发物化）、`in` 与 truthiness
 * 对任意支持货币成立（直连判定不触发物化）、继承属性（toString/constructor/原型链）委托
 * Reflect 与普通对象一致。
 *
 * Proxy 不变式加固（old-object 兼容）：
 * - 已物化/自定义/Symbol 属性 get/has/ownKeys/getOwnPropertyDescriptor 回真实结果；
 * - delete 支持货币（含已物化）后 get/has/ownKeys 全部省略，直到 set/defineProperty 恢复；
 * - preventExtensions/seal/freeze 先把全部未删除的支持货币一次性物化再反射防扩展——
 *   Object.keys 保持全量（与旧密集矩阵一致），ownKeys/描述符不变式不再抛 TypeError；
 * - 非可写非配置数据属性的 get 不变式返回精确值。
 */
function createSparseProxy<T>(
    currencies: readonly string[],
    factory: (prop: string) => T,
    onMaterialize: () => void,
): { [prop: string]: T } {
    const target: Record<PropertyKey, unknown> = {};
    const deleted = new Set<string>();
    const self: { proxy?: { [prop: string]: T } } = {};
    const handler: ProxyHandler<Record<PropertyKey, unknown>> = {
        get(proxyTarget, prop, receiver) {
            // 非可写非配置数据属性：Proxy 不变式要求返回精确值。
            const own = Object.getOwnPropertyDescriptor(proxyTarget, prop);
            if (
                own !== undefined &&
                own.configurable === false &&
                'value' in own &&
                own.writable === false
            ) {
                return own.value;
            }
            if (typeof prop === 'string' && currencies.includes(prop)) {
                if (deleted.has(prop)) return undefined;
                if (Object.prototype.hasOwnProperty.call(proxyTarget, prop)) {
                    // 已物化属性经 Reflect 读取：用户定义的访问器 getter 的 this 是公开
                    // proxy（旧普通对象语义），而不是裸 target。
                    return Reflect.get(proxyTarget, prop, receiver);
                }
                if (!Object.isExtensible(proxyTarget)) return undefined;
                onMaterialize();
                const value = factory(prop);
                proxyTarget[prop] = value;
                return value;
            }
            // 继承/未知属性委托原型链（普通对象语义：toString/constructor 等可用）。
            return Reflect.get(proxyTarget, prop, receiver);
        },
        has: (proxyTarget, prop) => {
            if (typeof prop === 'string' && currencies.includes(prop)) {
                return !deleted.has(prop);
            }
            return Reflect.has(proxyTarget, prop);
        },
        ownKeys: (proxyTarget) => {
            const materialized = Reflect.ownKeys(proxyTarget);
            if (!Object.isExtensible(proxyTarget)) {
                return materialized;
            }
            const seen = new Set(materialized);
            const result = [...materialized];
            for (const code of currencies) {
                if (deleted.has(code)) continue;
                if (!seen.has(code)) {
                    result.push(code);
                    seen.add(code);
                }
            }
            return result;
        },
        getOwnPropertyDescriptor: (proxyTarget, prop) => {
            if (Object.prototype.hasOwnProperty.call(proxyTarget, prop)) {
                return Reflect.getOwnPropertyDescriptor(proxyTarget, prop);
            }
            if (
                typeof prop === 'string' &&
                currencies.includes(prop) &&
                !deleted.has(prop) &&
                Object.isExtensible(proxyTarget)
            ) {
                // 未物化键返回访问器描述符：get/set 经代理读取/写入，展开/JSON/赋值拿到的是
                // 真实 row/cell（与旧密集矩阵一致），而 Object.keys/ownKeys 枚举不触发物化
                // （BFS 邻居枚举契约——getOwnPropertyDescriptor 的 get 只在取值时被调用）。
                return {
                    configurable: true,
                    enumerable: true,
                    get: () => self.proxy![prop] as T,
                    set: (value: unknown) => {
                        self.proxy![prop] = value as T;
                    },
                };
            }
            return undefined;
        },
        set: (proxyTarget, prop, value, receiver) => {
            if (receiver === self.proxy) {
                const own = Object.getOwnPropertyDescriptor(proxyTarget, prop);
                // 只读数据属性：赋值失败（严格模式调用方抛 TypeError，与普通对象一致）。
                if (
                    own !== undefined &&
                    'value' in own &&
                    own.writable === false
                ) {
                    return false;
                }
                if (own !== undefined && 'set' in own) {
                    // 用户定义的访问器属性：经 Reflect 调用以保持 setter 的 this === proxy。
                    const ok = Reflect.set(proxyTarget, prop, value, receiver);
                    if (
                        ok &&
                        typeof prop === 'string' &&
                        currencies.includes(prop)
                    ) {
                        deleted.delete(prop);
                    }
                    return ok;
                }
                try {
                    proxyTarget[prop] = value;
                } catch {
                    // 不可扩展目标上新增属性（如已删除键）赋值失败：不得恢复 deleted 状态，
                    // 否则 in 与 get 不一致（读 undefined 但 in 为 true）。
                    return false;
                }
                // 仅在赋值成功后恢复已删除键（set/defineProperty 成功前不得清 deleted）。
                if (typeof prop === 'string' && currencies.includes(prop)) {
                    deleted.delete(prop);
                }
                return true;
            }
            const ok = Reflect.set(proxyTarget, prop, value, receiver);
            if (ok && typeof prop === 'string' && currencies.includes(prop)) {
                deleted.delete(prop);
            }
            return ok;
        },
        defineProperty: (proxyTarget, prop, descriptor) => {
            if (
                typeof prop === 'string' &&
                currencies.includes(prop) &&
                !deleted.has(prop) &&
                descriptor !== undefined &&
                descriptor.configurable === false &&
                !Object.prototype.hasOwnProperty.call(proxyTarget, prop) &&
                Object.isExtensible(proxyTarget)
            ) {
                // freeze/seal 会把键收紧成不可配置：先物化，保证收紧后保留的是真实
                // row/cell（否则冻结后的虚拟键值恒为 undefined，与旧密集矩阵不符）。
                onMaterialize();
                proxyTarget[prop] = factory(prop);
            }
            const ok = Reflect.defineProperty(proxyTarget, prop, descriptor);
            // 仅在定义成功后恢复已删除键。
            if (ok && typeof prop === 'string' && currencies.includes(prop)) {
                deleted.delete(prop);
            }
            return ok;
        },
        deleteProperty: (proxyTarget, prop) => {
            if (typeof prop === 'string' && currencies.includes(prop)) {
                const hadOwn = Object.prototype.hasOwnProperty.call(
                    proxyTarget,
                    prop,
                );
                const desc = hadOwn
                    ? Object.getOwnPropertyDescriptor(proxyTarget, prop)
                    : undefined;
                if (desc !== undefined && desc.configurable === false) {
                    return false;
                }
                if (hadOwn) {
                    delete proxyTarget[prop];
                }
                deleted.add(prop);
                return true;
            }
            return Reflect.deleteProperty(proxyTarget, prop);
        },
        preventExtensions: (proxyTarget) => {
            // 防扩展前一次性物化全部未删除的支持货币，Object.keys 保持全量（同旧密集矩阵）。
            for (const code of currencies) {
                if (deleted.has(code)) continue;
                if (!Object.prototype.hasOwnProperty.call(proxyTarget, code)) {
                    onMaterialize();
                    proxyTarget[code] = factory(code);
                }
            }
            return Reflect.preventExtensions(proxyTarget);
        },
    };
    self.proxy = new Proxy(target, handler) as unknown as { [prop: string]: T };
    return self.proxy;
}

/**
 * 创建稀疏卡组织汇率表（替代 Phase 1 的全量 N×N Proxy 矩阵）。
 * 行/单元格按需物化：`[from]` 首次访问才建行、`[to]` 首次访问才建单元格；未访问的
 * pair 不占对象。单元格 key 按 `normalize(from)+normalize(to)` 对齐 coordinator 正缓存。
 */
export function createCardSparseMatrix(
    currencies: readonly string[],
    cache: LRUCache<string, CardRate>,
    normalize: (code: string) => string,
    stats?: CardSparseStats,
): { [from: string]: { [to: string]: FXRateType } } {
    const cellForKey = createCardRateCellFactory(cache);

    const makeRow = (from: string): { [to: string]: FXRateType } =>
        createSparseProxy<FXRateType>(
            currencies,
            (to) => cellForKey(`${normalize(from)}${normalize(to)}`),
            () => {
                if (stats !== undefined) stats.cells++;
            },
        );

    return createSparseProxy<{ [to: string]: FXRateType }>(
        currencies,
        makeRow,
        () => {
            if (stats !== undefined) stats.rows++;
        },
    );
}

/**
 * 全量 N×N typed 密集矩阵（回退实现）：一次性物化全部行/格，单元格仍是 createCardRateCell
 * Factory 的 live typed 视图（读取零 JSON.parse、每次读返回克隆）。仅当环境变量
 * FXRATE_CARD_DENSE_MATRIX=1 时由 createCardMatrix 选用——用于回退排查稀疏实现的差异，
 * 常规环境默认走稀疏矩阵（见 cardDenseMatrixEnabled）。
 */
export function createCardDenseMatrix(
    currencies: readonly string[],
    cache: LRUCache<string, CardRate>,
    normalize: (code: string) => string,
): { [from: string]: { [to: string]: FXRateType } } {
    const cellForKey = createCardRateCellFactory(cache);
    const matrix: { [from: string]: { [to: string]: FXRateType } } = {};
    for (const from of currencies) {
        const row: { [to: string]: FXRateType } = {};
        for (const to of currencies) {
            row[to] = cellForKey(`${normalize(from)}${normalize(to)}`);
        }
        matrix[from] = row;
    }
    return matrix;
}

/**
 * 默认稀疏回退旗标：FXRATE_CARD_DENSE_MATRIX=1 时返回 true（走全量 typed 密集矩阵），
 * 否则默认稀疏。矩阵在首次访问 fxRateList 时按当前环境变量决定，进程内稳定。
 */
export function cardDenseMatrixEnabled(): boolean {
    return process.env.FXRATE_CARD_DENSE_MATRIX === '1';
}

/**
 * 统一的矩阵工厂：默认稀疏（按需物化），FXRATE_CARD_DENSE_MATRIX=1 时回退全量 typed
 * 密集矩阵。两个实现共享同一 typed 正缓存与单元格工厂，对外契约一致。
 */
export function createCardMatrix(
    currencies: readonly string[],
    cache: LRUCache<string, CardRate>,
    normalize: (code: string) => string,
    stats?: CardSparseStats,
): { [from: string]: { [to: string]: FXRateType } } {
    if (cardDenseMatrixEnabled()) {
        return createCardDenseMatrix(currencies, cache, normalize);
    }
    return createCardSparseMatrix(currencies, cache, normalize, stats);
}

/** 允许的 updated 未来时钟偏差（与快照未来偏差契约一致：默认 5 分钟）。 */
export const CARD_RATE_FUTURE_SKEW_MS = 5 * 60_000;

/**
 * CardRate 最终校验（写正缓存前的最后一道门）：middle/cash/remit 必须是有限正 Fraction、
 * updated 必须是合法 Date 且不晚于 now + CARD_RATE_FUTURE_SKEW_MS。不合法抛错——
 * CardCoordinator 捕获后写入负缓存、绝不写正缓存（畸形上游 payload 不得以「成功」身份
 * 进入正缓存；曾出现 NaN/Infinity/Invalid Date/负价被静默缓存）。
 */
export function validateCardRate(rate: CardRate): void {
    const quotes: [string, Fraction][] = [
        ['middle', rate.middle],
        ['cash', rate.cash],
        ['remit', rate.remit],
    ];
    for (const [label, value] of quotes) {
        const isFinitePositive =
            isFraction(value) &&
            value.s > 0 &&
            value.n > 0 &&
            Number.isFinite(value.s) &&
            Number.isFinite(value.n) &&
            Number.isFinite(value.d) &&
            value.d > 0;
        if (!isFinitePositive) {
            throw new Error(
                `Invalid card rate ${label}: must be a finite positive fraction, got ${String(value)}`,
            );
        }
    }
    if (
        !(rate.updated instanceof Date) ||
        Number.isNaN(rate.updated.getTime())
    ) {
        throw new Error(
            `Invalid card rate updated: must be a valid Date, got ${String(rate.updated)}`,
        );
    }
    if (rate.updated.getTime() > Date.now() + CARD_RATE_FUTURE_SKEW_MS) {
        throw new Error(
            `Invalid card rate updated: timestamp is in the future (${rate.updated.toISOString()})`,
        );
    }
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
    /** 写正缓存前的 payload 级校验；不合法抛错（该失败同样计入负缓存）。 */
    validate: (payload: TPayload) => void;
    /**
     * 写正缓存前的存储值最终校验（在 serialize 之后对 TStored 把关，如 CardRate 的有限
     * 正报价/合法非未来日期）；不合法抛错同样计入负缓存、绝不写正缓存。
     * Card 源（mastercard/visa）必须提供（validateCardRate），畸形上游 payload 由此拒之。
     */
    validateStored?: (stored: TStored) => void;
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
     *
     * 成功写入顺序：validate(payload) → serialize → validateStored(stored) → 写正缓存 →
     * recordSuccess。任一步抛错（含最终存储值校验失败）都走负缓存并 rethrow——畸形
     * payload 绝不写正缓存；CapacityError 不污染负缓存。
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
                    const stored = this.options.serialize(payload);
                    // 最终校验门：存储值（如 CardRate）不合法的畸形 payload 在此抛错，
                    // 由下方 catch 记入负缓存、绝不写正缓存。
                    if (this.options.validateStored !== undefined) {
                        this.options.validateStored(stored);
                    }
                    this.options.positive.set(cacheKey, stored);
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
