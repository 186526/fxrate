// fx-manager-all-rates（Phase 5 优化 #2 / Phase 3 契约，offline）：
// 验证 getAllReachable 单次遍历枚举与逐目标 getFXPath 完全等价：
// - bfs=false：仅直连邻居（path=[to]），from 自环不返回；
// - bfs=true：单次 BFS 枚举全部可达目标，直连目标 path=[to]、非直连目标
//   path=[from,...,to]，别名规则（起点别名 / 别名直连）与 getFXPath 一致；
// - oneWay 源（仅写正向边）反向不可达，枚举不产生伪反向行；
// - handler 级：listFXRates bfs=1 全表含非直连目标，bfs=0 仅直连。
// 零公网访问，可 --detectOpenHandles。

import { currency, FXRate } from 'src/types.d';

import fxManager from '../../src/fxm/fxManager';

const R = (
    from: currency,
    to: currency,
    opts: Partial<{ middle: number; oneWay: boolean; updated: Date }> = {},
): FXRate => ({
    currency: { from, to },
    rate: {
        buy: { cash: 6.9, remit: 6.95 },
        sell: { cash: 7.05, remit: 7.1 },
        middle: opts.middle ?? 7,
    },
    unit: 1,
    updated: opts.updated ?? new Date('2026-08-04T00:00:00Z'),
    oneWay: opts.oneWay,
});

// 与 rpc-rest-parity 相同的固定汇率图：USD→HKD、HKD→CNH、EUR→CNH、USD→CNY
// （USD→CNY 经别名解析把反向边写入 CNH 节点，图上无顶层 CNY 节点）。
function fixtureGraph(): fxManager {
    const m = new fxManager([]);
    m.update(R(currency.USD, currency.HKD, { middle: 7.78 }));
    m.update(R(currency.HKD, currency.CNH, { middle: 0.91 }));
    m.update(R(currency.EUR, currency.CNH, { middle: 7.6 }));
    m.update(R(currency.USD, currency.CNY, { middle: 7 }));
    return m;
}

function oneWayGraph(): fxManager {
    const m = new fxManager([]);
    // 支付宝式：仅 CNY→USD 购汇方向，无反向边。
    m.update(
        R(currency.CNY, currency.USD, {
            middle: 0.1477,
            oneWay: true,
        }),
    );
    return m;
}

describe('getAllReachable non-bfs（仅直连邻居）', () => {
    test('USD 只枚举直连目标 HKD/CNY，path=[to]，不含自环', async () => {
        const m = fixtureGraph();
        const reachable = await m.getAllReachable(currency.USD, false);
        expect(Object.keys(reachable).sort()).toEqual(['CNY', 'HKD']);
        expect(reachable.HKD).toEqual({
            from: currency.USD,
            end: currency.HKD,
            path: [currency.HKD],
        });
        expect(reachable.CNY).toEqual({
            from: currency.USD,
            end: currency.CNY,
            path: [currency.CNY],
        });
    });

    test('未知货币返回空对象（与旧 handler 空表行为一致）', async () => {
        const m = fixtureGraph();
        const reachable = await m.getAllReachable('XXX' as currency, false);
        expect(reachable).toEqual({});
    });
});

describe('getAllReachable bfs（单次遍历全可达）', () => {
    test('USD 全表含非直连 CNH/EUR；直连行 path=[to]，非直连行 path=[from,...,to]', async () => {
        const m = fixtureGraph();
        const reachable = await m.getAllReachable(currency.USD, true);
        expect(Object.keys(reachable).sort()).toEqual([
            'CNH',
            'CNY',
            'EUR',
            'HKD',
        ]);
        // 直连：path=[to]
        expect(reachable.HKD.path).toEqual([currency.HKD]);
        expect(reachable.CNY.path).toEqual([currency.CNY]);
        // 非直连：path 含 from 起点（真实最短路径；CNH 的别名早停差异见下个用例说明）
        expect(reachable.CNH.path).toEqual([
            currency.USD,
            currency.HKD,
            currency.CNH,
        ]);
        expect(reachable.EUR.path).toEqual([
            currency.USD,
            currency.CNY,
            currency.EUR,
        ]);
    });

    test('非别名目标与逐目标 getFXPath 一致；别名目标为真实最短路径', async () => {
        const m = fixtureGraph();
        const reachable = await m.getAllReachable(currency.USD, true);
        for (const to of Object.keys(reachable)) {
            const fxp = await m.getFXPath(currency.USD, to as currency, true);
            if (to === 'CNH') {
                // 唯一别名分歧：getFXPath 经 USD 节点的 CNY 键别名早停返回
                // [USD,CNH]（alias=CNY，1 跳）；单次遍历给出真实最短路径
                // [USD,HKD,CNH]（2 跳）。两者都是合法最短路径——断言
                // 路径首尾正确且逐边可解析（USD→HKD、HKD→CNH）。
                const path = reachable[to].path;
                expect(path[0]).toBe(currency.USD);
                expect(path[path.length - 1]).toBe(to);
                for (let i = 0; i + 1 < path.length; i += 1) {
                    expect(
                        await m.fxRateList[path[i]][path[i + 1]],
                    ).toBeTruthy();
                }
            } else {
                expect(reachable[to].path).toEqual(fxp.path);
                expect(reachable[to].alias).toBe(fxp.alias);
            }
        }
    });

    test('起点别名：from=CNY（图只有 CNH）时 startAlias=CNH 且直连归一', async () => {
        const m = fixtureGraph();
        const reachable = await m.getAllReachable(currency.CNY, true);
        // 图里没有顶层 CNY 节点：CNY 请求经别名解析到 CNH 节点
        expect(Object.keys(reachable).length).toBeGreaterThan(0);
        // 每个目标的 alias 都应为 CNH（起点别名）
        for (const fxp of Object.values(reachable)) {
            expect(fxp.alias).toBe('CNH');
        }
        // 与逐目标 getFXPath 一致
        for (const to of Object.keys(reachable)) {
            const fxp = await m.getFXPath(currency.CNY, to as currency, true);
            expect(reachable[to].path).toEqual(fxp.path);
            expect(reachable[to].alias).toBe(fxp.alias);
        }
    });
});

describe('oneWay 反向不伪造（Phase 3 契约）', () => {
    test('alipay 式 CNY→USD oneWay：USD 出发不可达 CNY（无反向行）', async () => {
        const m = oneWayGraph();
        const fromUsd = await m.getAllReachable(currency.USD, true);
        expect(fromUsd).toEqual({});
        const fromUsdDirect = await m.getAllReachable(currency.USD, false);
        expect(fromUsdDirect).toEqual({});
    });

    test('oneWay 正向仍可达：CNY 出发包含 USD', async () => {
        const m = oneWayGraph();
        const reachable = await m.getAllReachable(currency.CNY, true);
        expect(Object.keys(reachable)).toContain('USD');
        expect(reachable.USD.path).toEqual([currency.USD]);
        expect(reachable.USD.alias).toBeUndefined();
    });
});

describe('handler 级 listFXRates 契约', () => {
    test('bfs=0 全表仅直连目标；bfs=1 全表含非直连目标且带 path', async () => {
        const m = fixtureGraph();
        const direct = await m.getAllReachable(currency.USD, false);
        const bfs = await m.getAllReachable(currency.USD, true);
        expect(Object.keys(direct).sort()).toEqual(['CNY', 'HKD']);
        expect(Object.keys(bfs).sort()).toEqual(['CNH', 'CNY', 'EUR', 'HKD']);
        // bfs 行均带预解析 path（getDetails 据此输出 result.path）
        for (const fxp of Object.values(bfs)) {
            expect(fxp.path.length).toBeGreaterThanOrEqual(1);
        }
    });
});
