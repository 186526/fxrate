// fx-manager-bfs-traversal（Phase 5 BFS 优化语义锁，offline）：
// 锁定优化后遍历机制的可观测行为——最短路径选择、等长路径的确定性平局
// （首个发现的父节点胜出）、别名节点出现在路径中段（虚拟起点 CNY → CNH 节点）、
// 别名目标归一、长链重构、不可达目标抛错。全部基于 getFXPath 的公开契约断言。
import fxManager from '../../src/fxm/fxManager';
import { currency, FXRate } from '../../src/types';

const UPDATED = new Date('2026-08-05T00:00:00Z');

const edge = (
    from: string,
    to: string,
    opts: { middle?: number; oneWay?: boolean } = {},
): FXRate =>
    ({
        currency: { from, to },
        rate: { middle: opts.middle ?? 1.5 },
        unit: 1,
        updated: UPDATED,
        oneWay: opts.oneWay,
    }) as FXRate;

describe('BFS traversal: shortest path and tie-breaking', () => {
    test('selects the fewest-hop path when a longer detour also exists', async () => {
        const m = new fxManager([]);
        m.update(edge('USD', 'HKD'));
        m.update(edge('HKD', 'EUR'));
        m.update(edge('USD', 'GBP'));
        m.update(edge('GBP', 'AUD'));
        m.update(edge('AUD', 'EUR'));
        const fxp = await m.getFXPath(currency.USD, currency.EUR, true);
        // 两条候选：USD→HKD→EUR（2 跳）与 USD→GBP→AUD→EUR（3 跳）→ 取最短
        expect(fxp.path).toEqual(['USD', 'HKD', 'EUR']);
        expect(fxp.alias).toBeUndefined();
    });

    test('equal-length alternatives break ties by first-discovered parent', async () => {
        const m = new fxManager([]);
        m.update(edge('USD', 'HKD'));
        m.update(edge('HKD', 'JPY'));
        m.update(edge('USD', 'EUR'));
        m.update(edge('EUR', 'JPY'));
        const fxp = await m.getFXPath(currency.USD, currency.JPY, true);
        // USD 邻居按插入序为 HKD、EUR：HKD 先被发现并先入队，率先命中 JPY
        expect(fxp.path).toEqual(['USD', 'HKD', 'JPY']);
        expect(fxp.alias).toBeUndefined();
    });

    test('first-discovered parent wins even when keys were added in reverse order', async () => {
        const m = new fxManager([]);
        m.update(edge('USD', 'EUR'));
        m.update(edge('EUR', 'JPY'));
        m.update(edge('USD', 'HKD'));
        m.update(edge('HKD', 'JPY'));
        const fxp = await m.getFXPath(currency.USD, currency.JPY, true);
        // 这次 EUR 先插入（先被发现），平局路径应走 EUR
        expect(fxp.path).toEqual(['USD', 'EUR', 'JPY']);
    });
});

describe('BFS traversal: CNY/CNH alias nodes inside the path', () => {
    test('virtual start CNY resolves through the CNH node and reconstructs its path', async () => {
        const m = new fxManager([]);
        m.update(edge('CNH', 'HKD'));
        m.update(edge('HKD', 'USD'));
        const fxp = await m.getFXPath(currency.CNY, currency.USD, true);
        // 图内无 CNY 也无 CNH→USD 直连：起点 CNY 经别名 CNH 节点进入 BFS，
        // 前驱链回放必须还原出以请求货币 CNY 开头的完整路径
        expect(fxp.path).toEqual(['CNY', 'HKD', 'USD']);
        expect(fxp.alias).toBe('CNH');
    });

    test('alias target normalizes the reconstructed tail to the requested currency', async () => {
        const m = new fxManager([]);
        m.update(edge('EUR', 'HKD'));
        m.update(edge('HKD', 'CNH'));
        const fxp = await m.getFXPath(currency.EUR, currency.CNY, true);
        expect(fxp.path).toEqual(['EUR', 'HKD', 'CNY']);
        expect(fxp.alias).toBe('CNH');
    });

    test('three-hop path through the alias pair keeps every node in order', async () => {
        const m = new fxManager([]);
        m.update(edge('EUR', 'HKD'));
        m.update(edge('HKD', 'CNH'));
        m.update(edge('CNH', 'JPY'));
        const fxp = await m.getFXPath(currency.EUR, currency.JPY, true);
        expect(fxp.path).toEqual(['EUR', 'HKD', 'CNH', 'JPY']);
        expect(fxp.alias).toBeUndefined();
    });
});

describe('BFS traversal: long chains and unreachable targets', () => {
    test('reconstructs a six-hop chain without repeats or order drift', async () => {
        const m = new fxManager([]);
        const chain = ['USD', 'HKD', 'EUR', 'GBP', 'AUD', 'NZD', 'SGD'];
        for (let i = 0; i + 1 < chain.length; i += 1) {
            m.update(edge(chain[i], chain[i + 1]));
        }
        const fxp = await m.getFXPath(currency.USD, currency.SGD, true);
        expect(fxp.path).toEqual(chain);
        expect(new Set(fxp.path).size).toBe(fxp.path.length);
    });

    test('star topology leaf-to-leaf crosses the hub exactly once', async () => {
        const m = new fxManager([]);
        m.update(edge('USD', 'HKD'));
        m.update(edge('USD', 'EUR'));
        m.update(edge('USD', 'GBP'));
        m.update(edge('USD', 'AUD'));
        const fxp = await m.getFXPath(currency.HKD, currency.GBP, true);
        expect(fxp.path).toEqual(['HKD', 'USD', 'GBP']);
    });

    test('unreachable target in another component throws', async () => {
        const m = new fxManager([]);
        m.update(edge('USD', 'HKD'));
        m.update(edge('EUR', 'GBP'));
        await expect(
            m.getFXPath(currency.USD, currency.GBP, true),
        ).rejects.toThrow('No FX path found between USD and GBP');
    });

    test('alias-only pair unreachable without edges still throws', async () => {
        const m = new fxManager([]);
        // CNH 节点存在（CNY 别名起点可解析），USD 节点存在但与 CNH 无连通
        m.update(edge('CNH', 'HKD'));
        m.update(edge('USD', 'EUR'));
        await expect(
            m.getFXPath(currency.CNY, currency.USD, true),
        ).rejects.toThrow('No FX path found between CNY and USD');
    });
});
