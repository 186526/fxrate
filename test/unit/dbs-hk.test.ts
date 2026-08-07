import { DBSRow } from '../../src/FXGetter/dbs-shared';
import { parseDBSHKRows } from '../../src/FXGetter/dbs.hk';

// DBS HK 是 HKD 基准：usdTT* 只是上游参考字段，不能生成外币→USD 直连边。
const rows: DBSRow[] = [
    {
        currency: 'SGD',
        hkdTTBuy: '6.076001',
        hkdTTSell: '6.148008',
        usdTTBuy: '1.290215',
        usdTTSell: '1.276691',
    },
    {
        currency: 'CNH',
        hkdTTBuy: '1.155246',
        hkdTTSell: '1.169800',
        usdTTBuy: '6.781987',
        usdTTSell: '6.714125',
    },
    { currency: 'HKD', hkdTTBuy: '1', hkdTTSell: '1' },
    { currency: 'USD', hkdTTBuy: '7.819415', hkdTTSell: '7.870089' },
];

describe('DBS HK source mapping', () => {
    test('只生成外币→HKD，忽略 usdTT* 参考字段', () => {
        const rates = parseDBSHKRows(rows, new Date('2026-08-07T00:00:00Z'));

        expect(rates).toHaveLength(2);
        expect(rates.every((rate) => rate.currency.to === 'HKD')).toBe(true);
        expect(rates.map((rate) => rate.currency.from).sort()).toEqual([
            'CNH',
            'SGD',
        ]);
        expect(
            rates.some(
                (rate) =>
                    rate.currency.from === 'SGD' && rate.currency.to === 'USD',
            ),
        ).toBe(false);
    });

    test('SGD HKD 买卖方向与数值保持正确', () => {
        const sgd = parseDBSHKRows(rows, new Date()).find(
            (rate) => rate.currency.from === 'SGD',
        )!;
        expect(sgd.currency.from).toBe('SGD');
        expect(sgd.currency.to).toBe('HKD');
        const buy = sgd.rate.buy?.remit as number;
        const sell = sgd.rate.sell?.remit as number;
        expect(buy).toBe(6.076001);
        expect(sell).toBe(6.148008);
        expect(buy).toBeLessThan(sell);
    });
});
