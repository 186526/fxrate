// fx-manager-bfs（Phase 3 语义修复，offline）：
// 一、BFS 多段换算的 updated 取路径上最旧边的更新时间；直连/别名直连保持自身 updated。
// 二、CNY/CNH 别名四种 from/to 组合（CNY→CNH、CNH→CNY、CNY→CNY、CNH→CNH）
//     均能解析路径并正确标记 alias；BFS 命中别名目标时路径末节点归一 + alias 标记。
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

// 三跳边 + 一条 EUR 边，updated 各不相同（08-01 / 08-02 / 08-03），
// 用于验证「取最旧边」语义；图内只有 CNH 节点（无 CNY），别名走 CNH。
const makeFixture = (): fxManager => {
    const m = new fxManager([]);
    m.update({
        currency: { from: 'USD', to: 'HKD' },
        rate: {
            buy: { cash: 7.8, remit: 7.8 },
            sell: { cash: 7.82, remit: 7.82 },
            middle: 7.81,
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
    return m;
};

describe('BFS path updated = oldest edge timestamp', () => {
    test('multi-hop BFS result.updated is the oldest edge updated', async () => {
        const m = makeFixture();
        const d = await getDetails(
            currency.USD,
            currency.CNY,
            m,
            makeReq('?bfs=1'),
        );
        // 路径 [USD, HKD, CNY]：边 USD→HKD (08-01)、HKD→CNH (08-02) → 最旧 08-01
        expect(d.updated).toBe(new Date('2026-08-01T00:00:00Z').toUTCString());
        expect(d.path).toEqual(['USD', 'HKD', 'CNY']);
        expect(d.alias).toBe('CNH');
    });

    test('reverse BFS path also reports the oldest edge updated', async () => {
        const m = makeFixture();
        const d = await getDetails(
            currency.CNY,
            currency.USD,
            m,
            makeReq('?bfs=1'),
        );
        // 反向路径 [CNY, HKD, USD] 与正向同边集合（CNH→HKD=08-02、HKD→USD=08-01）
        expect(d.updated).toBe(new Date('2026-08-01T00:00:00Z').toUTCString());
        expect(d.path).toEqual(['CNY', 'HKD', 'USD']);
        expect(d.alias).toBe('CNH');
    });

    test('direct quote keeps its own updated even with bfs=1', async () => {
        const m = makeFixture();
        const d = await getDetails(
            currency.USD,
            currency.HKD,
            m,
            makeReq('?bfs=1'),
        );
        expect(d.updated).toBe(new Date('2026-08-01T00:00:00Z').toUTCString());
        expect(d.path).toEqual(['HKD']);
    });

    test('alias-resolved direct quote (HKD→CNY via HKD→CNH) keeps its own updated', async () => {
        const m = makeFixture();
        const d = await getDetails(
            currency.HKD,
            currency.CNY,
            m,
            makeReq('?bfs=1'),
        );
        expect(d.updated).toBe(new Date('2026-08-02T00:00:00Z').toUTCString());
        expect(d.path).toEqual(['CNY']);
        expect(d.alias).toBe('CNH');
    });

    test('getPathUpdatedDate returns the oldest edge along arbitrary paths', async () => {
        const m = makeFixture();
        const d = await m.getPathUpdatedDate([
            currency.USD,
            currency.HKD,
            currency.CNY,
        ]);
        expect(d.toISOString()).toBe('2026-08-01T00:00:00.000Z');
        const d2 = await m.getPathUpdatedDate([
            currency.CNY,
            currency.HKD,
            currency.USD,
        ]);
        expect(d2.toISOString()).toBe('2026-08-01T00:00:00.000Z');
        const d3 = await m.getPathUpdatedDate([currency.USD, currency.HKD]);
        expect(d3.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    });

    test('BFS convert still computes the correct cross rate', async () => {
        const m = makeFixture();
        const r = await m.convert(
            currency.USD,
            currency.CNY,
            'middle',
            100,
            false,
            true,
        );
        // 100 USD → HKD (7.81) → CNH (0.91)：100 × 7.81 × 0.91 = 710.71
        expect(Number(r)).toBeCloseTo(100 * 7.81 * 0.91, 10);
    });

    test('BFS-reachable pair without a direct rate still returns cash/remit/middle', async () => {
        // 图中只有 USD→HKD 与 HKD→CNH（无 USD→CNY 直连），buy/sell 的 cash/remit
        // 各异，用于区分三价断言。
        const m = new fxManager([]);
        m.update({
            currency: { from: 'USD', to: 'HKD' },
            rate: {
                buy: { cash: 7.8, remit: 7.85 },
                sell: { cash: 7.9, remit: 7.95 },
                middle: 7.85,
            },
            unit: 1,
            updated: new Date('2026-08-04T00:00:00Z'),
        } as FXRate);
        m.update({
            currency: { from: 'HKD', to: 'CNH' },
            rate: {
                buy: { cash: 0.9, remit: 0.91 },
                sell: { cash: 0.93, remit: 0.94 },
                middle: 0.92,
            },
            unit: 1,
            updated: new Date('2026-08-04T01:00:00Z'),
        } as FXRate);
        const d = await getDetails(
            currency.USD,
            currency.CNY,
            m,
            makeReq('?bfs=1'),
        );
        expect(d.path).toEqual(['USD', 'HKD', 'CNY']);
        expect(d.alias).toBe('CNH');
        // 三价均按路径折算：middle=100×7.85×0.92、cash=100×7.8×0.9、remit=100×7.85×0.91
        expect(d.middle).toBeCloseTo(100 * 7.85 * 0.92, 10);
        expect(d.cash).toBeCloseTo(100 * 7.8 * 0.9, 10);
        expect(d.remit).toBeCloseTo(100 * 7.85 * 0.91, 10);
    });
});

describe('CNY/CNH alias: all four from/to combinations resolve', () => {
    test('CNY → CNH resolves via from-side alias and marks alias=CNH', async () => {
        const m = makeFixture();
        const fxp = await m.getFXPath(currency.CNY, currency.CNH, true);
        expect(fxp.path).toEqual(['CNH']);
        expect(fxp.alias).toBe('CNH');
        // 别名自换算：CNY 与 CNH 等价，1:1
        expect(
            Number(await m.convert(currency.CNY, currency.CNH, 'middle', 100)),
        ).toBe(100);
    });

    test('CNH → CNY resolves via to-side alias and marks alias=CNH', async () => {
        const m = makeFixture();
        const fxp = await m.getFXPath(currency.CNH, currency.CNY, true);
        expect(fxp.path).toEqual(['CNY']);
        expect(fxp.alias).toBe('CNH');
        expect(
            Number(await m.convert(currency.CNH, currency.CNY, 'middle', 100)),
        ).toBe(100);
    });

    test('CNY → CNY (same-side alias, only CNH in graph) resolves without alias', async () => {
        const m = makeFixture();
        const fxp = await m.getFXPath(currency.CNY, currency.CNY, true);
        // from===to 短路：自换算路径为请求货币本身，不经过任何汇率边
        expect(fxp.path).toEqual(['CNY']);
        expect(fxp.alias).toBeUndefined();
        expect(
            Number(await m.convert(currency.CNY, currency.CNY, 'middle', 100)),
        ).toBe(100);
    });

    test('CNH → CNH resolves as same-currency self path', async () => {
        const m = makeFixture();
        const fxp = await m.getFXPath(currency.CNH, currency.CNH, true);
        expect(fxp.path).toEqual(['CNH']);
        expect(fxp.alias).toBeUndefined();
        expect(
            Number(await m.convert(currency.CNH, currency.CNH, 'middle', 100)),
        ).toBe(100);
    });

    test('BFS via alias target normalizes tail to requested currency', async () => {
        const m = makeFixture();
        const fxp = await m.getFXPath(currency.USD, currency.CNY, true);
        // 图内无 USD→CNH 直连，BFS 经 HKD；末节点 CNH 归一为请求的 CNY
        expect(fxp.path).toEqual(['USD', 'HKD', 'CNY']);
        expect(fxp.alias).toBe('CNH');
    });
});
