// fx-manager-path-reuse（Phase 5 优化 #1 语义锁，offline）：
// getDetails 对 cash/remit/middle 复用同一条解析路径——每 pair 恰好一次 getFXPath
// （旧实现为 1 次显式 + 3 次 convert 各自重新解析 = 4 次路径解析）。复用后输出
// 与 fx-manager-golden.test.ts 预录的逐字节 deepEqual 完全一致（identical wire output）。
// 覆盖：direct / BFS 多跳 / reverse / oneWay 拒绝 / CNY-CNH alias / self / amount+fees /
// precision=-1 精确重复小数 / 不可达 pair（0 次解析，价格降级 false）。
import fxManager from '../../src/fxm/fxManager';
import { getDetails } from '../../src/handler/rest';
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

// 计数一次 getDetails 内的 getFXPath 调用（路径解析次数）：劫持实例方法，
// convert 内部 this.getFXPath 同样走被包装版本；convertAlongPath 不再触发。
const countPathResolutions = (m: fxManager) => {
    const original = m.getFXPath.bind(m);
    let resolved = 0;
    m.getFXPath = (async (from: currency, to: currency, allowBFS = false) => {
        resolved += 1;
        return original(from, to, allowBFS);
    }) as typeof m.getFXPath;
    return { count: () => resolved };
};

// 与 fx-manager-golden.test.ts 相同的固定汇率图（updated 固定，golden 值确定）：
//   USD→HKD  7.75/7.78 买  7.80/7.82 卖  中 7.78    @08-01
//   HKD→CNH  0.90/0.90 买  0.92/0.92 卖  中 0.91    @08-02
//   EUR→CNH  仅中 7.6                                     @08-03
//   USD→CNY  6.90/6.95 买  7.05/7.10 卖  中 7.00    @08-04
//   JPY→USD  仅中 0.0067（oneWay，不写反向）        @08-04T01
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

describe('getDetails resolves the FX path exactly once per pair', () => {
    test('direct pair (non-bfs): one resolution, identical golden output', async () => {
        const m = makeFixture();
        const { count } = countPathResolutions(m);
        const d = await getDetails(
            currency.USD,
            currency.CNY,
            m,
            makeReq('?precision=5'),
        );
        expect(count()).toBe(1);
        expect(d).toEqual({
            updated: 'Tue, 04 Aug 2026 00:00:00 GMT',
            cash: 690,
            remit: 695,
            middle: 700,
        });
    });

    test('BFS multi-hop: one resolution reused by all three types', async () => {
        const m = makeFixture();
        const { count } = countPathResolutions(m);
        const d = await getDetails(
            currency.USD,
            currency.EUR,
            m,
            makeReq('?bfs=1&precision=5'),
        );
        expect(count()).toBe(1);
        expect(d).toEqual({
            updated: 'Mon, 03 Aug 2026 00:00:00 GMT',
            path: ['USD', 'CNY', 'EUR'],
            cash: 90.78947,
            remit: 91.44737,
            middle: 92.10526,
        });
    });

    test('reverse direction (non-bfs): one resolution, identical golden output', async () => {
        const m = makeFixture();
        const { count } = countPathResolutions(m);
        const d = await getDetails(
            currency.CNY,
            currency.USD,
            m,
            makeReq('?precision=5'),
        );
        expect(count()).toBe(1);
        expect(d).toEqual({
            updated: 'Tue, 04 Aug 2026 00:00:00 GMT',
            cash: 14.1844,
            remit: 14.08451,
            middle: 14.28571,
        });
    });

    test('alias-resolved direct quote (bfs): one resolution, alias + own updated', async () => {
        const m = makeFixture();
        const { count } = countPathResolutions(m);
        const d = await getDetails(
            currency.HKD,
            currency.CNY,
            m,
            makeReq('?bfs=1&precision=5'),
        );
        expect(count()).toBe(1);
        expect(d).toEqual({
            updated: 'Sun, 02 Aug 2026 00:00:00 GMT',
            path: ['CNY'],
            alias: 'CNH',
            cash: 90,
            remit: 90,
            middle: 91,
        });
    });

    test('self-convert (from === to): one resolution, 1:1 prices', async () => {
        const m = makeFixture();
        const { count } = countPathResolutions(m);
        const d = await getDetails(
            currency.CNY,
            currency.CNY,
            m,
            makeReq('?bfs=1&precision=5'),
        );
        expect(count()).toBe(1);
        expect(d).toEqual({
            updated: 'Thu, 01 Jan 1970 00:00:00 GMT',
            path: ['CNY'],
            cash: 100,
            remit: 100,
            middle: 100,
        });
    });

    test('amount + fees scale the three prices with one resolution', async () => {
        const m = makeFixture();
        const { count } = countPathResolutions(m);
        const d = await getDetails(
            currency.USD,
            currency.CNY,
            m,
            makeReq('?amount=500&fees=2&precision=5'),
        );
        expect(count()).toBe(1);
        expect(d).toEqual({
            updated: 'Tue, 04 Aug 2026 00:00:00 GMT',
            cash: 3519,
            remit: 3544.5,
            middle: 3570,
        });
    });

    test('precision=-1 preserves exact repeating Fraction strings with one resolution', async () => {
        const m = makeFixture();
        const { count } = countPathResolutions(m);
        const d = await getDetails(
            currency.USD,
            currency.EUR,
            m,
            makeReq('?bfs=1&precision=-1'),
        );
        expect(count()).toBe(1);
        expect(d).toEqual({
            updated: 'Mon, 03 Aug 2026 00:00:00 GMT',
            path: ['USD', 'CNY', 'EUR'],
            cash: '90.(789473684210526315)',
            remit: '91.4(473684210526315789)',
            middle: '92.(105263157894736842)',
        });
    });

    test('oneWay reverse rejected: path=[], prices false, single failed resolution', async () => {
        const m = makeFixture();
        const { count } = countPathResolutions(m);
        const d = await getDetails(
            currency.USD,
            currency.JPY,
            m,
            makeReq('?bfs=1&precision=5'),
        );
        expect(count()).toBe(1);
        expect(d.path).toEqual([]);
        expect(d.alias).toBeUndefined();
        expect(d.cash).toBe(false);
        expect(d.remit).toBe(false);
        expect(d.middle).toBe(false);
    });

    test('unreachable pair without bfs needs no path and degrades prices to false', async () => {
        const m = makeFixture();
        const { count } = countPathResolutions(m);
        const d = await getDetails(
            currency.USD,
            currency.EUR,
            m,
            makeReq('?precision=5'),
        );
        expect(count()).toBe(0);
        expect(d.path).toBeUndefined();
        expect(d.cash).toBe(false);
        expect(d.remit).toBe(false);
        expect(d.middle).toBe(false);
    });
});

describe('convertAlongPath produces the same result as convert', () => {
    test('multi-hop BFS path via shared-path API matches convert', async () => {
        const m = makeFixture();
        const fxp = await m.getFXPath(currency.USD, currency.EUR, true);
        const direct = await m.convert(
            currency.USD,
            currency.EUR,
            'middle',
            100,
            false,
            true,
        );
        const shared = await m.convertAlongPath(
            currency.USD,
            currency.EUR,
            'middle',
            100,
            fxp.path,
        );
        expect(Number(shared)).toBe(Number(direct));
    });

    test('direct path via shared-path API matches convert', async () => {
        const m = makeFixture();
        const fxp = await m.getFXPath(currency.USD, currency.CNY, false);
        const direct = await m.convert(currency.USD, currency.CNY, 'cash', 100);
        const shared = await m.convertAlongPath(
            currency.USD,
            currency.CNY,
            'cash',
            100,
            fxp.path,
        );
        expect(Number(shared)).toBe(Number(direct));
    });

    test('reverse path via shared-path API matches convert', async () => {
        const m = makeFixture();
        const fxp = await m.getFXPath(currency.USD, currency.CNY, false);
        const direct = await m.convert(
            currency.USD,
            currency.CNY,
            'remit',
            100,
            true,
        );
        const shared = await m.convertAlongPath(
            currency.USD,
            currency.CNY,
            'remit',
            100,
            fxp.path,
            true,
        );
        expect(Number(shared)).toBe(Number(direct));
    });

    test('convert reuses the shared-path implementation (single resolution)', async () => {
        const m = makeFixture();
        const { count } = countPathResolutions(m);
        await m.convert(currency.USD, currency.EUR, 'middle', 100, false, true);
        expect(count()).toBe(1);
    });
});
