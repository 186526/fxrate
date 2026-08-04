import { create, all, Fraction } from 'mathjs';
import { currency, FXRate, FXPath } from 'src/types.d';

const math = create(all, {
    number: 'Fraction',
});

const { multiply, divide, fraction, add } = math;

export type FXRateType = {
    cash: Fraction;
    remit: Fraction;
    middle: Fraction;
    updated: Date;
};

export default class fxManager {
    private _fxRateList: {
        [from: string]: { [to: string]: FXRateType };
    } = {};

    public get fxRateList(): {
        [from: string]: { [to: string]: FXRateType };
    } {
        const fxRateList = new Proxy(this._fxRateList, {
            get: function (target, prop) {
                if (typeof prop !== 'string') return undefined;

                let child = target[prop];

                if (prop == 'CNY' && !('CNY' in target)) {
                    if ('CNH' in target) {
                        child = target['CNH'];
                    }
                }

                if (!child) {
                    return undefined;
                }

                return new Proxy(child, {
                    get: function (target, prop) {
                        if (typeof prop !== 'string') return undefined;

                        let child = target[prop];

                        if (prop == 'CNY' && !('CNY' in target)) {
                            if ('CNH' in target) {
                                child = target['CNH'];
                            }
                        }

                        return child;
                    },
                });
            },
        });

        return fxRateList;
    }

    public set fxRateList(value: {
        [from: string]: { [to: string]: FXRateType };
    }) {
        this._fxRateList = value;
    }

    // 持久化快照：导出/导入内存汇率表（供 JSON 落盘，冷启动跳过上游抓取）
    public snapshot(): {
        [from: string]: { [to: string]: FXRateType };
    } {
        return this._fxRateList;
    }

    public restore(value: { [from: string]: { [to: string]: FXRateType } }) {
        this._fxRateList = value;
    }

    // 同步可用数据判定（readiness 契约，Phase 7）：实例是否已加载过至少一条
    // 有效非 self 报价。直接读私有 _fxRateList（不经 fxRateList Proxy getter——
    // 惰性 FXM 子类的 Proxy 每次访问都会物化 51k 单元格，绝不能在就绪探针里触发）；
    // 结构判定即可：update() 原子提交/restore() 快照校验保证非 self 单元格必然完整合法。
    public hasUsableData(): boolean {
        for (const from of Object.keys(this._fxRateList)) {
            for (const to of Object.keys(this._fxRateList[from])) {
                if (from !== to) return true;
            }
        }
        return false;
    }

    public async getfxRateList(
        from: currency,
        to: currency,
    ): Promise<FXRateType> {
        return this.fxRateList[from][to];
    }

    public async setfxRateList(
        from: currency,
        to: currency,
        value: {
            cash: Fraction;
            remit: Fraction;
            middle: Fraction;
            updated: Date;
        },
    ) {
        this.fxRateList[from][to] = value;
    }

    ableToGetAllFXRate: boolean = true;

    constructor(FXRates: FXRate[]) {
        FXRates.forEach((fxRate) => {
            try {
                this.update(fxRate);
            } catch (e) {
                console.error(e, fxRate);
            }
        });
        return this;
    }

    // 严格 getter 输入校验：unit/rates 必须为有限正数、updated 必须是合法 Date、
    // 货币代码必须是 3 位大写字母（ISO 风格）。任何非法输入直接抛错，
    // 且校验发生在触碰 _fxRateList 之前，保证异常时快照与提交前 deep-equal。
    private validateFXRate(FXRate: FXRate): void {
        const { currency, unit, updated, rate } = FXRate;

        const isValidCurrencyCode = (code: unknown): code is string =>
            typeof code === 'string' && /^[A-Z]{3}$/.test(code);
        if (
            !isValidCurrencyCode(currency?.from) ||
            !isValidCurrencyCode(currency?.to)
        ) {
            throw new Error(
                `Invalid FXRate currency: ${String(currency?.from)}/${String(currency?.to)}`,
            );
        }

        if (typeof unit !== 'number' || !Number.isFinite(unit) || unit <= 0) {
            throw new Error(`Invalid FXRate unit: ${String(unit)}`);
        }

        if (!(updated instanceof Date) || Number.isNaN(updated.getTime())) {
            throw new Error(`Invalid FXRate updated: ${String(updated)}`);
        }

        if (!rate || typeof rate !== 'object' || Array.isArray(rate)) {
            throw new Error('Invalid FXRate rate');
        }

        const rateValues: [string, unknown][] = [
            ['buy.cash', rate?.buy?.cash],
            ['buy.remit', rate?.buy?.remit],
            ['sell.cash', rate?.sell?.cash],
            ['sell.remit', rate?.sell?.remit],
            ['middle', rate?.middle],
        ];
        for (const [label, value] of rateValues) {
            if (value === undefined) continue;
            const isFinitePositive =
                (typeof value === 'number' &&
                    Number.isFinite(value) &&
                    value > 0) ||
                (math.isFraction(value) &&
                    (value as Fraction).s > 0 &&
                    (value as Fraction).n > 0);
            if (!isFinitePositive) {
                throw new Error(
                    `Invalid FXRate rate.${label}: ${String(value)}`,
                );
            }
        }
    }

    // 与 fxRateList getter Proxy 相同的 CNY/CNH 别名解析：请求 CNY 而图内
    // 只有 CNH 节点时，读写都落到 CNH 节点上（保持 update 写路径的别名语义）。
    private resolveAliasKey(
        code: currency,
        graph: { [from: string]: { [to: string]: FXRateType } },
    ): string {
        if (
            code === ('CNY' as currency.CNY) &&
            !(code in graph) &&
            'CNH' in graph
        ) {
            return 'CNH';
        }
        return code as string;
    }

    private static selfRate(): FXRateType {
        return {
            cash: fraction(1),
            remit: fraction(1),
            middle: fraction(1),
            updated: new Date('1970-1-1 00:00:00 UTC'),
        };
    }

    public update(FXRate: FXRate): void {
        if (FXRate === null) return;

        // 严格输入校验：任何非法数据在此抛错，尚未触碰 _fxRateList。
        this.validateFXRate(FXRate);

        const { currency, unit } = FXRate;
        let { rate } = FXRate;

        let { from, to } = currency;

        if (from == ('RMB' as currency.RMB)) from = 'CNY' as currency.CNY;
        if (to == ('RMB' as currency.RMB)) to = 'CNY' as currency.CNY;

        if (this.fxRateList[from] && this.fxRateList[from][to]) {
            if (this.fxRateList[from][to].updated > FXRate.updated) return;
        }

        // 注意：getter 里 buy/sell 常被初始化为空对象 {}（truthy），
        // 所以必须按字段值判断是否真的有买卖价，否则中间价兜底会失效。
        const hasBuy = !!(rate.buy?.cash || rate.buy?.remit);
        const hasSell = !!(rate.sell?.cash || rate.sell?.remit);

        if (!hasBuy && !hasSell && !rate.middle) {
            console.log(FXRate);
            throw new Error('Invalid FXRate');
        }

        if (!hasBuy && !hasSell) {
            rate = {
                buy: {
                    cash: rate.middle,
                    remit: rate.middle,
                },
                sell: {
                    cash: rate.middle,
                    remit: rate.middle,
                },
                middle: rate.middle,
            };
        } else if (!hasBuy && rate.sell) {
            rate.buy = rate.sell;
        } else if (!hasSell && rate.buy) {
            rate.sell = rate.buy;
        }

        if (!rate.middle) {
            rate.middle = divide(
                add(
                    math.min(
                        rate.buy?.cash || Infinity,
                        rate.buy?.remit || Infinity,
                        rate.sell?.cash || Infinity,
                        rate.sell?.remit || Infinity,
                    ),
                    math.max(
                        rate.buy?.cash || -Infinity,
                        rate.buy?.remit || -Infinity,
                        rate.sell?.cash || -Infinity,
                        rate.sell?.remit || -Infinity,
                    ),
                ),
                2,
            ) as Fraction;
        }

        // 单项缺失时按 现金价 → 汇价 → 中间价 依次回落，保证 cash/remit 都有值
        const buyCash = rate.buy?.cash ?? rate.buy?.remit ?? rate.middle;
        const buyRemit = rate.buy?.remit ?? rate.buy?.cash ?? rate.middle;
        const sellCash = rate.sell?.cash ?? rate.sell?.remit ?? rate.middle;
        const sellRemit = rate.sell?.remit ?? rate.sell?.cash ?? rate.middle;

        // oneWay 源（如支付宝消费结算汇率）反向无实际业务，跳过反向写入——
        // fxRateList 中不存在反向键，直连查询报 No FX path found，BFS 也不会经过伪反向。
        const existingReverse = this.fxRateList[to]?.[from];
        const shouldUpdateReverse =
            !FXRate.oneWay &&
            (!existingReverse || existingReverse.updated <= FXRate.updated);

        // —— 原子提交：以下全部先在本地结构计算，全部成功后才一次性替换 _fxRateList ——
        // 任何异常（如 fraction 转换失败）都发生在 commit 之前，
        // 因此异常发生时快照与调用前 deep-equal（不产生部分写入）。
        const next: { [from: string]: { [to: string]: FXRateType } } = {
            ...this._fxRateList,
        };

        const fromNodeKey = this.resolveAliasKey(from, next);
        if (!next[fromNodeKey]) {
            next[from] = {
                [from]: fxManager.selfRate(),
            };
        }
        next[fromNodeKey] = {
            ...next[fromNodeKey],
            [to]: {
                middle: divide(fraction(rate.middle), unit) as Fraction,
                cash: divide(fraction(buyCash), unit) as Fraction,
                remit: divide(fraction(buyRemit), unit) as Fraction,
                updated: FXRate.updated,
            },
        };

        const toNodeKey = this.resolveAliasKey(to, next);
        if (!next[toNodeKey]) {
            next[to] = {
                [to]: fxManager.selfRate(),
            };
        }
        if (shouldUpdateReverse) {
            next[toNodeKey] = {
                ...next[toNodeKey],
                [from]: {
                    middle: divide(unit, fraction(rate.middle)) as Fraction,
                    cash: divide(unit, fraction(sellCash)) as Fraction,
                    remit: divide(unit, fraction(sellRemit)) as Fraction,
                    updated: FXRate.updated,
                },
            };
        }

        // 单点提交：全部计算成功后一次性替换引用，异常永远走不到这一步。
        this._fxRateList = next;
    }

    private async convertDirect(
        from: currency,
        to: currency,
        type: 'cash' | 'remit' | 'middle',
        amount: number | Fraction,
        reverse: boolean = false,
    ): Promise<Fraction> {
        if (!(await this.getfxRateList(from, to))[type]) {
            throw new Error(
                `FX Path from ${from} to ${to} not support ${type} now`,
            );
        }
        if (reverse) {
            return divide(
                fraction(amount),
                (await this.fxRateList[from][to])[type],
            ) as unknown as Fraction;
        }
        return multiply(
            (await this.fxRateList[from][to])[type],
            fraction(amount),
        ) as unknown as Fraction;
    }

    async getFXPath(
        from: currency,
        to: currency,
        allowBFS: boolean = false,
    ): Promise<FXPath> {
        const FXPath = {
            from,
            end: to,
            path: [],
        } as FXPath;

        if (from === to) {
            FXPath.path.push(from);
            return FXPath;
        }

        // CNY/CNH 别名 fallback 检测：Proxy get trap 会静默把不存在的 CNY/CNH
        // 映射到图里实际存在的别名（如 DBS/OCBC 只有 CNH），直连判断与 BFS 起点
        // 都可能实际使用别名货币（如 USD→CNY 实际用 USD→CNH 行）——统一标记 alias
        // 供 API 响应提示（result.alias + X-FXRate-Alias header），2026-08 实测。
        const ALIAS_MAP: Partial<Record<string, currency>> = {
            CNY: 'CNH' as currency.CNH,
            CNH: 'CNY' as currency.CNY,
        };
        const fromNode = this.fxRateList[from];
        let aliasUsed: currency | undefined;
        if (!(from in this.fxRateList)) {
            // 一级 fallback：from 节点本身不存在（CNY 请求，图里只有 CNH）
            aliasUsed = ALIAS_MAP[from as string];
        } else if (fromNode && !(to in fromNode)) {
            // 二级 fallback：from 节点存在但 to 边不存在（USD→CNY，图里只有 USD→CNH）
            aliasUsed = ALIAS_MAP[to as string];
        }
        if (aliasUsed) FXPath.alias = aliasUsed;

        if (this.fxRateList[from] && this.fxRateList[from][to]) {
            FXPath.path.push(to);
            return FXPath;
        }
        if (!this.fxRateList[from] || !this.fxRateList[to]) {
            throw new Error('Invalid currency');
        }
        // 默认不启用 BFS：交叉汇率有累积误差（如经 HKD 折算 USD/CNY），
        // 仅当调用方显式请求（?bfs=1）时才在汇率图上搜索中间货币路径。
        if (!allowBFS) {
            throw new Error(`No FX path found between ${from} and ${to}`);
        }
        // CNY/CNH 互为别名（update 时只写入其一，如 DBS/OCBC 用 CNH 报价）。
        // 直连判断走 Proxy get 有别名 fallback，但 BFS 的邻居枚举走 Object.keys（ownKeys）
        // 不经过 get trap，导致「目标 CNY 但图里只有 CNH」时找不到路径（2026-08 实测）。
        const isAlias = (a: currency, b: currency): boolean =>
            (a === ('CNY' as currency.CNY) && b === ('CNH' as currency.CNH)) ||
            (a === ('CNH' as currency.CNH) && b === ('CNY' as currency.CNY));

        // Phase 5 BFS 优化（语义与朴素版本等价，见 fx-manager-golden.test.ts 语义锁）：
        // ① 队列用索引游标（head++）替代 queue.shift()——出队摊还 O(1)，消除每轮 O(n) 平移；
        // ② visited 数组（includes 每次 O(n)）换成前驱 Map（has/set 均 O(1)），同时兼作
        //    路径重构表——命中目标时按前驱链一次性回放完整路径，替代入队时逐节点复制
        //    path 数组（O(n²) 分配 → O(路径长度)）；
        // ③ 访问标记从「出队」提前到「入队」：BFS 的 FIFO 顺序保证两者的首个发现顺序与
        //    最短路径完全一致（同一层父节点谁先被出队谁先发现目标，平局规则不变）。
        const queue: currency[] = [from];
        let head = 0;
        const prev = new Map<currency, currency>();
        prev.set(from, from);

        while (head < queue.length) {
            const current = queue[head];
            head += 1;

            if (current === to || isAlias(current, to)) {
                // 按前驱链回放完整路径（含起点 from），与朴素版本入队时的累积 path 一致。
                const path: currency[] = [];
                let node: currency = current;
                while (node !== from) {
                    path.push(node);
                    node = prev.get(node) as currency;
                }
                path.push(from);
                path.reverse();
                // 命中别名目标时，路径末节点归一为目标货币（CNH → CNY），
                // 保证 convert 按用户请求的 to 输出且 path 展示不含别名噪音。
                const normalized =
                    isAlias(current, to) && current !== to
                        ? [...path.slice(0, -1), to]
                        : path;
                FXPath.path = normalized;
                // 记录实际使用的别名货币，供 API 响应提示（X-FXRate-Alias header / result.alias）
                if (current !== to) FXPath.alias = current;
                return FXPath;
            }

            const neighbors = Object.keys(
                this.fxRateList[current],
            ) as currency[];
            for (const neighbor of neighbors) {
                if (neighbor === current) continue;
                if (!prev.has(neighbor)) {
                    prev.set(neighbor, current);
                    queue.push(neighbor);
                }
            }
        }

        throw new Error('No FX path found between ' + from + ' and ' + to);
    }

    async convert(
        from: currency,
        to: currency,
        type: 'cash' | 'remit' | 'middle',
        amount: number,
        reverse: boolean = false,
        allowBFS: boolean = false,
    ): Promise<Fraction> {
        const FXPath = await this.getFXPath(from, to, allowBFS);
        const path =
            FXPath.path[0] === from ? FXPath.path : [from, ...FXPath.path];
        const conversionPath = reverse ? [...path].reverse() : path;

        let current = conversionPath[0];
        let result = fraction(amount);

        try {
            for (const next of conversionPath.slice(1)) {
                result = await this.convertDirect(current, next, type, result);
                current = next;
            }
        } catch (e) {
            throw new Error(
                `Cannot convert from ${from} to ${to} with ${type}: \n${(e as Error).message}`,
            );
        }

        return result;
    }

    public async getUpdatedDate(from: currency, to: currency): Promise<Date> {
        if (!(await this.fxRateList[from][to])) {
            throw new Error(`FX Path from ${from} to ${to} not found`);
        }
        return (await this.fxRateList[from][to]).updated;
    }

    // BFS 多段换算的更新时间：取路径上所有相邻边 updated 的最小值（最旧）。
    // 交叉汇率是多段折算，任一段陈旧都代表整条路径陈旧，直连报价仍用自身 updated。
    // 边读取走 fxRateList Proxy get trap，CNY/CNH 别名目标（如 HKD→CNY 实际为
    // HKD→CNH 行）同样正确解析；路径无有效时间戳时抛错由调用方兜底。
    public async getPathUpdatedDate(path: currency[]): Promise<Date> {
        let oldest: Date | undefined;
        for (let i = 0; i + 1 < path.length; i += 1) {
            const edge = await this.fxRateList[path[i]][path[i + 1]];
            const timestamp =
                edge?.updated instanceof Date
                    ? edge.updated.getTime()
                    : Number.NaN;
            if (
                !Number.isNaN(timestamp) &&
                (!oldest || timestamp < oldest.getTime())
            ) {
                oldest = edge.updated;
            }
        }
        if (!oldest) {
            throw new Error(
                `No updated timestamp found on FX path ${path.join(' → ')}`,
            );
        }
        return oldest;
    }
}
