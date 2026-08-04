// rss-buy-sell（Phase 3 语义修复，offline）：非对称点差 fixture 下，
// RSS 的买入/卖出价必须取自点差两侧。修复前卖出请求 `${from}/${to}?reverse`
// 等价于买入请求 `${to}/${from}`（reverse 把路径反转回 to→from），买卖价相同；
// 修复后卖出走反向报价 `${from}/${to}`（1/卖出价），buy !== sell。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RSSHandler } from '../../src/handler/rss';
import fxmManager from '../../src/fxmManager';
import { currency } from '../../src/types';

const managers: fxmManager[] = [];

let cacheDir: string;

beforeAll(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'fxrate-rss-'));
    process.env.FXRATE_CACHE_DIR = cacheDir;
    process.env.LOG_LEVEL = 'error';
});

afterAll(() => {
    delete process.env.FXRATE_CACHE_DIR;
    delete process.env.LOG_LEVEL;
    rmSync(cacheDir, { recursive: true, force: true });
});

afterEach(() => {
    for (const manager of managers) manager.stopAllInterval();
    managers.length = 0;
});

// 非对称点差 fixture：买入 6.90/6.95、卖出 7.05/7.10、中间价 7
const makeManager = (): fxmManager => {
    const manager = new fxmManager({
        fixture: async () => [
            {
                currency: {
                    from: 'USD' as currency.USD,
                    to: 'CNY' as currency.CNY,
                },
                rate: {
                    buy: { cash: 6.9, remit: 6.95 },
                    sell: { cash: 7.05, remit: 7.1 },
                    middle: 7,
                },
                unit: 1,
                updated: new Date('2026-08-04T00:00:00Z'),
            },
        ],
    });
    managers.push(manager);
    return manager;
};

describe('RSS buy/sell sides against asymmetric spread fixtures', () => {
    test('buy and sell come from opposite sides of the spread (buy != sell)', async () => {
        const manager = makeManager();
        const rss = new RSSHandler(manager);
        const prices = await rss.requestPrice('CNY', 'USD');
        expect(prices).toHaveLength(1);
        const p = prices[0];
        // 修复前 sell 与 buy 完全相同；修复后两侧不同
        expect(p.remit).not.toBe(p.sellRemit);
        expect(p.cash).not.toBe(p.sellCash);
        expect(p.middle).not.toBe(p.sellMiddle);
        // 买入侧：getDetails(USD, CNY) = 100 × 买入价（remit 6.95 / cash 6.9 / middle 7）
        expect(p.remit).toBe(695);
        expect(p.cash).toBe(690);
        expect(p.middle).toBe(700);
        // 卖出侧：getDetails(CNY, USD) = 100 × (1/卖出价)（7.1 / 7.05 / 7），precision=4
        expect(p.sellRemit).toBeCloseTo(100 / 7.1, 4);
        expect(p.sellCash).toBeCloseTo(100 / 7.05, 4);
        expect(p.sellMiddle).toBeCloseTo(100 / 7, 4);
        // updated 两侧都来自同一条汇率（08-04）
        expect(p.updated).toBe(new Date('2026-08-04T00:00:00Z').toUTCString());
    });

    test('swapping the pair swaps the buy/sell values symmetrically', async () => {
        const manager = makeManager();
        const rss = new RSSHandler(manager);
        const prices = await rss.requestPrice('USD', 'CNY');
        expect(prices).toHaveLength(1);
        const p = prices[0];
        expect(p.remit).toBeCloseTo(100 / 7.1, 4);
        expect(p.sellRemit).toBe(695);
    });
});
