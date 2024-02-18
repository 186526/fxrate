import { create, all, Fraction } from 'mathjs';
import { currency, FXRate, FXPath } from '../types';

const math = create(all, {
    number: 'Fraction',
});

const { multiply, divide, fraction, add } = math;

export default class fxManager {
    public fxRateList: {
        [currency in keyof currency]: {
            [currency in keyof currency]: {
                cash: Fraction;
                remit: Fraction;
                middle: Fraction;
                updated: Date;
            };
        };
    } = {} as any;

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
        const { currency, unit } = FXRate;
        let { rate } = FXRate;
        const { from, to } = currency;

        if (this.fxRateList[from] && this.fxRateList[from][to]) {
            if (this.fxRateList[from][to].updated > FXRate.updated) return;
        }

        if (!rate.buy && !rate.sell) {
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
        } else if (!rate.buy && rate.sell) {
            rate.buy = rate.sell;
        } else if (!rate.sell && rate.buy) {
            rate.sell = rate.buy;
        } else if (!rate.middle) {
            rate.middle = divide(
                add(
                    math.min(
                        rate.buy.cash || Infinity,
                        rate.buy.remit || Infinity,
                        rate.sell.cash || Infinity,
                        rate.sell.remit || Infinity,
                    ),
                    math.max(
                        rate.buy.cash || -Infinity,
                        rate.buy.remit || -Infinity,
                        rate.sell.cash || -Infinity,
                        rate.sell.remit || -Infinity,
                    ),
                ),
                2,
            ) as Fraction;
        } else if (!rate.buy && !rate.sell && !rate.middle) {
            console.log(FXRate);
            throw new Error('Invalid FXRate');
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
            middle: divide(fraction(rate.middle), unit),
            updated: FXRate.updated,
        };
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
        this.fxRateList[to][from] = {
            middle: divide(unit, fraction(rate.middle)),
            updated: FXRate.updated,
        };

        if (rate.buy.cash) {
            this.fxRateList[from][to].cash = divide(
                fraction(rate.buy.cash),
                unit,
            );
        }

        if (rate.sell.cash) {
            this.fxRateList[to][from].cash = divide(
                unit,
                fraction(rate.sell.cash),
            );
        }

        if (rate.buy.remit) {
            this.fxRateList[from][to].remit = divide(
                fraction(rate.buy.remit),
                unit,
            );
        }

        if (rate.sell.remit) {
            this.fxRateList[to][from].remit = divide(
                unit,
                fraction(rate.sell.remit),
            );
        }
    }

    private convertDirect(
        from: currency,
        to: currency,
        type: 'cash' | 'remit' | 'middle',
        amount: number | Fraction,
        reverse: boolean = false,
    ): Fraction {
        if (!this.fxRateList[from][to][type]) {
            throw new Error(
                `FX Path from ${from} to ${to} not support ${type} now`,
            );
        }
        if (reverse) {
            return divide(
                fraction(amount),
                this.fxRateList[from][to][type],
            ) as unknown as Fraction;
        }
        return multiply(
            this.fxRateList[from][to][type],
            fraction(amount),
        ) as unknown as Fraction;
    }

    getFXPath(from: currency, to: currency): FXPath {
        const FXPath = {
            from,
            end: to,
            path: [],
        } as FXPath;

        if (from === to) {
            FXPath.path.push(from);
            return FXPath;
        }
        if (this.fxRateList[from][to]) {
            FXPath.path.push(to);
            return FXPath;
        }
        if (!this.fxRateList[from] || !this.fxRateList[to]) {
            throw new Error('Invalid currency');
        }
        const queue: { currency: currency; path: currency[] }[] = [];
        const visited: currency[] = [];

        queue.push({ currency: from, path: [from] });

        while (queue.length > 0) {
            const { currency, path } = queue.shift()!;
            visited.push(currency);

            if (currency === to) {
                FXPath.path = path;
                return FXPath;
            }

            const neighbors = Object.keys(
                this.fxRateList[currency],
            ) as currency[];
            for (const neighbor of neighbors) {
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

    convert(
        from: currency,
        to: currency,
        type: 'cash' | 'remit' | 'middle',
        amount: number,
        reverse: boolean = false,
    ): Fraction {
        const FXPath = this.getFXPath(from, to);
        if (reverse) FXPath.path = FXPath.path.reverse();

        let current = from;
        let result = fraction(amount);

        try {
            for (const next of FXPath.path) {
                result = this.convertDirect(
                    current,
                    next,
                    type,
                    result,
                    reverse,
                );
                current = next;
            }
        } catch (e) {
            throw new Error(
                `Cannot convert from ${from} to ${to} with ${type}: \n${e.message}`,
            );
        }

        return result;
    }

    public getUpdatedDate(from: currency, to: currency): Date {
        if (!this.fxRateList[from][to]) {
            throw new Error(`FX Path from ${from} to ${to} not found`);
        }
        return this.fxRateList[from][to].updated;
    }
}
