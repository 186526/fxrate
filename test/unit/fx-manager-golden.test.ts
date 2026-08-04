// fx-manager-golden（Phase 5 性能优化前的语义锁，offline）：
// 固定汇率图 fixture 上，getDetails/getConvert 的完整输出与预录 golden 值
// 逐字节 deepEqual——任何重构/优化不得改变可观测输出（直接锁 dead，非 toBeCloseTo）。
// 覆盖：direct / BFS 多跳 / reverse / oneWay / CNY-CNH alias / amount / fees / precision（含 -1 精确 Fraction）。
// 图（固定 updated，保证 golden 的 updated 字段确定）：
//   USD→HKD  7.75/7.78 买  7.80/7.82 卖  中 7.78    @08-01
//   HKD→CNH  0.90/0.90 买  0.92/0.92 卖  中 0.91    @08-02
//   EUR→CNH  仅中 7.6                                     @08-03
//   USD→CNY  6.90/6.95 买  7.05/7.10 卖  中 7.00    @08-04
//   JPY→USD  仅中 0.0067（oneWay，不写反向）        @08-04T01
import fxManager from '../../src/fxm/fxManager';
import { getDetails, getConvert } from '../../src/handler/rest';
import { request, interfaces } from 'handlers.js';
import { currency, FXRate } from '../../src/types';

const makeReq = (url: string) =>
    new request(
        'GET',
        new URL(`http://this.internal/${url}`),
        new interfaces.headers({}),
        '',
        {},
    );

const makeFixture = (): fxManager => {
    const m = new fxManager([]);
    m.update({
        currency: { from: 'USD', to: 'HKD' },
        rate: {
            buy: { cash: 7.75, remit: 7.78 },
            sell: { cash: 7.8, remit: 7.82 },
            middle: 7.78,
        },
        unit: 1,
        updated: new Date('2026-08-01T00:00:00Z'),
    } as FXRate);
    m.update({
        currency: { from: 'HKD', to: 'CNH' },
        rate: {
            buy: { cash: 0.9, remit: 0.9 },
            sell: { cash: 0.92, remit: 0.92 },
            middle: 0.91,
        },
        unit: 1,
        updated: new Date('2026-08-02T00:00:00Z'),
    } as FXRate);
    m.update({
        currency: { from: 'EUR', to: 'CNH' },
        rate: { middle: 7.6 },
        unit: 1,
        updated: new Date('2026-08-03T00:00:00Z'),
    } as FXRate);
    m.update({
        currency: { from: 'USD', to: 'CNY' },
        rate: {
            buy: { cash: 6.9, remit: 6.95 },
            sell: { cash: 7.05, remit: 7.1 },
            middle: 7,
        },
        unit: 1,
        updated: new Date('2026-08-04T00:00:00Z'),
    } as FXRate);
    m.update({
        currency: { from: 'JPY', to: 'USD' },
        rate: { middle: 0.0067 },
        unit: 1,
        updated: new Date('2026-08-04T01:00:00Z'),
        oneWay: true,
    } as FXRate);
    return m;
};

describe('golden: direct pair', () => {
    test('USD→CNY direct quote (precision 5) matches pre-recorded output', async () => {
        const m = makeFixture();
        const d = await getDetails(
            currency.USD,
            currency.CNY,
            m,
            makeReq('?precision=5'),
        );
        expect(d).toEqual({
            updated: 'Tue, 04 Aug 2026 00:00:00 GMT',
            cash: 690,
            remit: 695,
            middle: 700,
        });
    });
});

describe('golden: BFS multi-hop', () => {
    test('USD→EUR via CNY (BFS, no direct edge, precision 5)', async () => {
        const m = makeFixture();
        const d = await getDetails(
            currency.USD,
            currency.EUR,
            m,
            makeReq('?bfs=1&precision=5'),
        );
        expect(d).toEqual({
            updated: 'Mon, 03 Aug 2026 00:00:00 GMT',
            path: ['USD', 'CNY', 'EUR'],
            cash: 90.78947,
            remit: 91.44737,
            middle: 92.10526,
        });
    });

    test('EUR→USD reverse BFS path reports oldest edge updated', async () => {
        const m = makeFixture();
        const d = await getDetails(
            currency.EUR,
            currency.USD,
            m,
            makeReq('?bfs=1&precision=5'),
        );
        expect(d).toEqual({
            updated: 'Mon, 03 Aug 2026 00:00:00 GMT',
            path: ['EUR', 'CNH', 'USD'],
            cash: 107.80142,
            remit: 107.04225,
            middle: 108.57143,
        });
    });

    test('USD→EUR BFS precision 2 rounding', async () => {
        const m = makeFixture();
        const d = await getDetails(
            currency.USD,
            currency.EUR,
            m,
            makeReq('?bfs=1&precision=2'),
        );
        expect(d).toEqual({
            updated: 'Mon, 03 Aug 2026 00:00:00 GMT',
            path: ['USD', 'CNY', 'EUR'],
            cash: 90.79,
            remit: 91.45,
            middle: 92.11,
        });
    });

    test('USD→EUR BFS precision 0 rounding', async () => {
        const m = makeFixture();
        const d = await getDetails(
            currency.USD,
            currency.EUR,
            m,
            makeReq('?bfs=1&precision=0'),
        );
        expect(d).toEqual({
            updated: 'Mon, 03 Aug 2026 00:00:00 GMT',
            path: ['USD', 'CNY', 'EUR'],
            cash: 91,
            remit: 91,
            middle: 92,
        });
    });

    test('USD→EUR BFS precision -1 preserves exact repeating Fractions', async () => {
        const m = makeFixture();
        const d = await getDetails(
            currency.USD,
            currency.EUR,
            m,
            makeReq('?bfs=1&precision=-1'),
        );
        expect(d).toEqual({
            updated: 'Mon, 03 Aug 2026 00:00:00 GMT',
            path: ['USD', 'CNY', 'EUR'],
            cash: '90.(789473684210526315)',
            remit: '91.4(473684210526315789)',
            middle: '92.(105263157894736842)',
        });
    });
});

describe('golden: reverse direction', () => {
    test('CNY→USD uses stored reverse edges (1/sell side, precision 5)', async () => {
        const m = makeFixture();
        const d = await getDetails(
            currency.CNY,
            currency.USD,
            m,
            makeReq('?precision=5'),
        );
        expect(d).toEqual({
            updated: 'Tue, 04 Aug 2026 00:00:00 GMT',
            cash: 14.1844,
            remit: 14.08451,
            middle: 14.28571,
        });
    });

    test('CNY→USD with ?reverse folds to forward USD→CNY (precision 5)', async () => {
        const m = makeFixture();
        const d = await getDetails(
            currency.CNY,
            currency.USD,
            m,
            makeReq('?reverse&precision=5'),
        );
        expect(d).toEqual({
            updated: 'Tue, 04 Aug 2026 00:00:00 GMT',
            cash: 690,
            remit: 695,
            middle: 700,
        });
    });

    test('CNY→USD with ?reverse and precision 0', async () => {
        const m = makeFixture();
        const d = await getDetails(
            currency.CNY,
            currency.USD,
            m,
            makeReq('?reverse&precision=0'),
        );
        expect(d).toEqual({
            updated: 'Tue, 04 Aug 2026 00:00:00 GMT',
            cash: 690,
            remit: 695,
            middle: 700,
        });
    });
});

describe('golden: oneWay source exclusion', () => {
    test('JPY→USD forward quote works (oneWay direction)', async () => {
        const m = makeFixture();
        const d = await getDetails(
            currency.JPY,
            currency.USD,
            m,
            makeReq('?precision=5'),
        );
        expect(d).toEqual({
            updated: 'Tue, 04 Aug 2026 01:00:00 GMT',
            cash: 0.67,
            remit: 0.67,
            middle: 0.67,
        });
    });

    test('USD→JPY reverse convert rejects (no reverse edge, with and without BFS)', async () => {
        const m = makeFixture();
        await expect(
            m.convert(currency.USD, currency.JPY, 'middle', 100),
        ).rejects.toThrow('No FX path found between USD and JPY');
        await expect(
            m.convert(currency.USD, currency.JPY, 'middle', 100, false, true),
        ).rejects.toThrow('No FX path found between USD and JPY');
    });
});

describe('golden: CNY/CNH alias both ends', () => {
    test('HKD→CNY via alias (HKD→CNH edge) keeps own updated', async () => {
        const m = makeFixture();
        const d = await getDetails(
            currency.HKD,
            currency.CNY,
            m,
            makeReq('?bfs=1&precision=5'),
        );
        expect(d).toEqual({
            updated: 'Sun, 02 Aug 2026 00:00:00 GMT',
            path: ['CNY'],
            alias: 'CNH',
            cash: 90,
            remit: 90,
            middle: 91,
        });
    });

    test('CNY→HKD via alias from-side (CNH node) marks alias CNH', async () => {
        const m = makeFixture();
        const d = await getDetails(
            currency.CNY,
            currency.HKD,
            m,
            makeReq('?bfs=1&precision=5'),
        );
        expect(d).toEqual({
            updated: 'Sun, 02 Aug 2026 00:00:00 GMT',
            path: ['HKD'],
            alias: 'CNH',
            cash: 108.69565,
            remit: 108.69565,
            middle: 109.89011,
        });
    });

    test('EUR→CNY alias direct (EUR→CNH edge via proxy fallback)', async () => {
        const m = makeFixture();
        const d = await getDetails(
            currency.EUR,
            currency.CNY,
            m,
            makeReq('?bfs=1&precision=5'),
        );
        expect(d).toEqual({
            updated: 'Mon, 03 Aug 2026 00:00:00 GMT',
            path: ['CNY'],
            alias: 'CNH',
            cash: 760,
            remit: 760,
            middle: 760,
        });
    });

    test('CNY→CNY self-convert (1:1, no alias, self-rate timestamp)', async () => {
        const m = makeFixture();
        const d = await getDetails(
            currency.CNY,
            currency.CNY,
            m,
            makeReq('?bfs=1&precision=5'),
        );
        expect(d).toEqual({
            updated: 'Thu, 01 Jan 1970 00:00:00 GMT',
            path: ['CNY'],
            cash: 100,
            remit: 100,
            middle: 100,
        });
    });

    test('CNH→CNH self-convert (1:1, no alias, self-rate timestamp)', async () => {
        const m = makeFixture();
        const d = await getDetails(
            currency.CNH,
            currency.CNH,
            m,
            makeReq('?bfs=1&precision=5'),
        );
        expect(d).toEqual({
            updated: 'Thu, 01 Jan 1970 00:00:00 GMT',
            path: ['CNH'],
            cash: 100,
            remit: 100,
            middle: 100,
        });
    });
});

describe('golden: amount conversion', () => {
    test('amount=500 scales all three prices', async () => {
        const m = makeFixture();
        const d = await getDetails(
            currency.USD,
            currency.CNY,
            m,
            makeReq('?amount=500&precision=5'),
        );
        expect(d).toEqual({
            updated: 'Tue, 04 Aug 2026 00:00:00 GMT',
            cash: 3450,
            remit: 3475,
            middle: 3500,
        });
    });

    test('amount=0 falls back to default 100', async () => {
        const m = makeFixture();
        const d = await getDetails(
            currency.USD,
            currency.CNY,
            m,
            makeReq('?amount=0&precision=5'),
        );
        expect(d).toEqual({
            updated: 'Tue, 04 Aug 2026 00:00:00 GMT',
            cash: 690,
            remit: 695,
            middle: 700,
        });
    });
});

describe('golden: fees multiplier', () => {
    test('fees=2 multiplies all prices by 1.02', async () => {
        const m = makeFixture();
        const d = await getDetails(
            currency.USD,
            currency.CNY,
            m,
            makeReq('?fees=2&precision=5'),
        );
        expect(d).toEqual({
            updated: 'Tue, 04 Aug 2026 00:00:00 GMT',
            cash: 703.8,
            remit: 708.9,
            middle: 714,
        });
    });

    test('fees=250 multiplies all prices by 3.5', async () => {
        const m = makeFixture();
        const d = await getDetails(
            currency.USD,
            currency.CNY,
            m,
            makeReq('?fees=250&precision=5'),
        );
        expect(d).toEqual({
            updated: 'Tue, 04 Aug 2026 00:00:00 GMT',
            cash: 2415,
            remit: 2432.5,
            middle: 2450,
        });
    });
});

describe('golden: precision rounding', () => {
    test('precision 0 rounds to integer', async () => {
        const m = makeFixture();
        const d = await getDetails(
            currency.CNY,
            currency.USD,
            m,
            makeReq('?precision=0'),
        );
        expect(d).toEqual({
            updated: 'Tue, 04 Aug 2026 00:00:00 GMT',
            cash: 14,
            remit: 14,
            middle: 14,
        });
    });

    test('precision 2 rounds to 2 decimals', async () => {
        const m = makeFixture();
        const d = await getDetails(
            currency.CNY,
            currency.USD,
            m,
            makeReq('?precision=2'),
        );
        expect(d).toEqual({
            updated: 'Tue, 04 Aug 2026 00:00:00 GMT',
            cash: 14.18,
            remit: 14.08,
            middle: 14.29,
        });
    });

    test('precision 6 rounds to 6 decimals', async () => {
        const m = makeFixture();
        const d = await getDetails(
            currency.CNY,
            currency.USD,
            m,
            makeReq('?precision=6'),
        );
        expect(d).toEqual({
            updated: 'Tue, 04 Aug 2026 00:00:00 GMT',
            cash: 14.184397,
            remit: 14.084507,
            middle: 14.285714,
        });
    });

    test('precision -1 keeps exact repeating-decimal Fraction strings', async () => {
        const m = makeFixture();
        const d = await getDetails(
            currency.CNY,
            currency.USD,
            m,
            makeReq('?precision=-1'),
        );
        expect(d).toEqual({
            updated: 'Tue, 04 Aug 2026 00:00:00 GMT',
            cash: '14.(1843971631205673758865248226950354609929078014)',
            remit: '14.(08450704225352112676056338028169014)',
            middle: '14.(285714)',
        });
    });
});

describe('golden: getConvert direct combos', () => {
    test('amount=500 fees=2 precision=4 on middle', async () => {
        const m = makeFixture();
        const r = await getConvert(
            currency.USD,
            currency.CNY,
            'middle',
            m,
            makeReq('?amount=500&fees=2&precision=4'),
        );
        expect(r).toBe(3570);
    });

    test('precision -1 returns exact integer as number, repeating as string', async () => {
        const m = makeFixture();
        expect(
            await getConvert(
                currency.USD,
                currency.CNY,
                'middle',
                m,
                makeReq('?precision=-1'),
            ),
        ).toBe(700);
        expect(
            await getConvert(
                currency.CNY,
                currency.USD,
                'middle',
                m,
                makeReq('?precision=-1'),
            ),
        ).toBe('14.(285714)');
        expect(
            await getConvert(
                currency.CNY,
                currency.USD,
                'cash',
                m,
                makeReq('?precision=-1'),
            ),
        ).toBe('14.(1843971631205673758865248226950354609929078014)');
    });

    test('?reverse folds USD→CNY remit to 1/sell-remit', async () => {
        const m = makeFixture();
        expect(
            await getConvert(
                currency.USD,
                currency.CNY,
                'remit',
                m,
                makeReq('?precision=2&reverse'),
            ),
        ).toBe(14.08);
    });

    test('BFS multi-hop middle precision 4', async () => {
        const m = makeFixture();
        expect(
            await getConvert(
                currency.USD,
                currency.EUR,
                'middle',
                m,
                makeReq('?bfs=1&precision=4'),
            ),
        ).toBe(92.1053);
    });

    test('BFS multi-hop cash precision 4 with fees=1', async () => {
        const m = makeFixture();
        expect(
            await getConvert(
                currency.USD,
                currency.EUR,
                'cash',
                m,
                makeReq('?bfs=1&precision=4&fees=1'),
            ),
        ).toBe(91.6974);
    });
});
