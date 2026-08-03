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

    public update(FXRate: FXRate): void {
        if (FXRate === null) return;

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

        if (!this.fxRateList[from]) {
            this.fxRateList[from] = {
                [from]: {
                    cash: fraction(1),
                    remit: fraction(1),
                    middle: fraction(1),
                    updated: new Date(`1970-1-1 00:00:00 UTC`),
                },
            };
        }
        this.fxRateList[from][to] = {
            middle: divide(fraction(rate.middle), unit) as Fraction,
            updated: FXRate.updated,
        } as FXRateType;
        if (!this.fxRateList[to]) {
            this.fxRateList[to] = {
                [to]: {
                    cash: fraction(1),
                    remit: fraction(1),
                    middle: fraction(1),
                    updated: new Date(`1970-1-1 00:00:00 UTC`),
                },
            };
        }
        // oneWay 源（如支付宝消费结算汇率）反向无实际业务，跳过反向写入——
        // fxRateList 中不存在反向键，直连查询报 No FX path found，BFS 也不会经过伪反向。
        const shouldUpdateReverse =
            !FXRate.oneWay &&
            (!this.fxRateList[to][from] ||
                this.fxRateList[to][from].updated <= FXRate.updated);
        if (shouldUpdateReverse) {
            this.fxRateList[to][from] = {
                middle: divide(unit, fraction(rate.middle)) as Fraction,
                updated: FXRate.updated,
            } as FXRateType;
        }

        // 单项缺失时按 现金价 → 汇价 → 中间价 依次回落，保证 cash/remit 都有值
        const buyCash = rate.buy?.cash ?? rate.buy?.remit ?? rate.middle;
        const buyRemit = rate.buy?.remit ?? rate.buy?.cash ?? rate.middle;
        const sellCash = rate.sell?.cash ?? rate.sell?.remit ?? rate.middle;
        const sellRemit = rate.sell?.remit ?? rate.sell?.cash ?? rate.middle;

        this.fxRateList[from][to].cash = divide(
            fraction(buyCash),
            unit,
        ) as Fraction;
        this.fxRateList[from][to].remit = divide(
            fraction(buyRemit),
            unit,
        ) as Fraction;
        if (shouldUpdateReverse) {
            this.fxRateList[to][from].cash = divide(
                unit,
                fraction(sellCash),
            ) as Fraction;
            this.fxRateList[to][from].remit = divide(
                unit,
                fraction(sellRemit),
            ) as Fraction;
        }
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
        const queue: { currency: currency; path: currency[] }[] = [];
        const visited: currency[] = [];

        // CNY/CNH 互为别名（update 时只写入其一，如 DBS/OCBC 用 CNH 报价）。
        // 直连判断走 Proxy get 有别名 fallback，但 BFS 的邻居枚举走 Object.keys（ownKeys）
        // 不经过 get trap，导致「目标 CNY 但图里只有 CNH」时找不到路径（2026-08 实测）。
        const isAlias = (a: currency, b: currency): boolean =>
            (a === ('CNY' as currency.CNY) &&
                b === ('CNH' as currency.CNH)) ||
            (a === ('CNH' as currency.CNH) &&
                b === ('CNY' as currency.CNY));

        queue.push({ currency: from, path: [from] });

        while (queue.length > 0) {
            const { currency, path } = queue.shift()!;
            visited.push(currency);

            if (currency === to || isAlias(currency, to)) {
                // 命中别名目标时，路径末节点归一为目标货币（CNH → CNY），
                // 保证 convert 按用户请求的 to 输出且 path 展示不含别名噪音。
                const normalized =
                    isAlias(currency, to) && currency !== to
                        ? [...path.slice(0, -1), to]
                        : path;
                FXPath.path = normalized;
                // 记录实际使用的别名货币，供 API 响应提示（X-FXRate-Alias header / result.alias）
                if (currency !== to) FXPath.alias = currency;
                return FXPath;
            }

            const neighbors = Object.keys(
                this.fxRateList[currency],
            ) as currency[];
            for (const neighbor of neighbors) {
                if (neighbor === currency) continue;
                if (!visited.includes(neighbor)) {
                    queue.push({
                        currency: neighbor,
                        path: [...path, neighbor],
                    });
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
}
