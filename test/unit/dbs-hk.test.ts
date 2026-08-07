import {
    DBSRow,
    parseDBSHKUSDRow,
    parseDBSRow,
} from '../../src/FXGetter/dbs-shared';

// DBS HK USD 计价方向回归测试：usdTT 是「1 USD = X 外币」口径，必须取倒数。
// 曾只对 CNY/CNH 取倒数、SGD 等其他外币直接透传，导致方向反了（2026-08 修复）。
const USD_ROW: DBSRow = {
    currency: 'SGD',
    hkdTTBuy: '6.076001',
    hkdTTSell: '6.148008',
    usdTTBuy: '1.290215',
    usdTTSell: '1.276691',
};

describe('parseDBSRow（HKD 计价）', () => {
    const fx = parseDBSRow(
        { ...USD_ROW, ttBuy: USD_ROW.hkdTTBuy, ttSell: USD_ROW.hkdTTSell },
        'HKD',
        new Date('2026-08-07T00:00:00Z'),
    );

    test('方向：1 SGD = X HKD，买入价 < 卖出价', () => {
        expect(fx).not.toBeNull();
        expect(fx!.currency.from).toBe('SGD');
        expect(fx!.currency.to).toBe('HKD');
        const buy = fx!.rate.buy.remit as number;
        const sell = fx!.rate.sell.remit as number;
        expect(buy).toBe(6.076001);
        expect(sell).toBe(6.148008);
        expect(buy).toBeLessThan(sell);
    });
});

describe('parseDBSHKUSDRow（USD 计价）', () => {
    test('方向：1 SGD = 1/1.290215 USD ≈ 0.775，买入价 < 卖出价', () => {
        const fx = parseDBSHKUSDRow(USD_ROW, new Date('2026-08-07T00:00:00Z'));
        expect(fx).not.toBeNull();
        expect(fx!.currency.from).toBe('SGD');
        expect(fx!.currency.to).toBe('USD');
        const buy = fx!.rate.buy.remit as number;
        const sell = fx!.rate.sell.remit as number;
        expect(buy).toBeCloseTo(1 / 1.290215, 9);
        expect(sell).toBeCloseTo(1 / 1.276691, 9);
        expect(buy).toBeLessThan(sell);
    });

    test('非 CNY 外币（SGD）与 CNY 同样取倒数——曾只对 CNY 特例处理', () => {
        const sgd = parseDBSHKUSDRow(USD_ROW, new Date());
        const cnh = parseDBSHKUSDRow(
            {
                currency: 'CNH',
                hkdTTBuy: '1.155246',
                hkdTTSell: '1.169800',
                usdTTBuy: '6.781987',
                usdTTSell: '6.714125',
            },
            new Date(),
        );
        expect(sgd!.currency.from).toBe('SGD');
        expect(cnh!.currency.from).toBe('CNH');
        expect(sgd!.rate.buy.remit as number).toBeCloseTo(1 / 1.290215, 9);
        expect(cnh!.rate.buy.remit as number).toBeCloseTo(1 / 6.781987, 9);
    });

    test('非法/非正数 usdTT 返回 null', () => {
        expect(
            parseDBSHKUSDRow({ ...USD_ROW, usdTTBuy: '0' }, new Date()),
        ).toBeNull();
        expect(
            parseDBSHKUSDRow({ ...USD_ROW, usdTTBuy: undefined }, new Date()),
        ).toBeNull();
        expect(
            parseDBSHKUSDRow({ ...USD_ROW, usdTTBuy: '-1' }, new Date()),
        ).toBeNull();
    });

    test('SGD→USD 100 单位换算合理（≈77.5，而非 129.0 的错误值）', () => {
        const fx = parseDBSHKUSDRow(USD_ROW, new Date());
        const buy = fx!.rate.buy.remit as number;
        // 用户侧 100 SGD 可换的 USD 数 = 100 × 银行买入 SGD 价
        expect(100 * buy).toBeGreaterThan(70);
        expect(100 * buy).toBeLessThan(85);
    });
});
