// fx-manager-atomic：Phase 3 原子图更新契约测试。
// 覆盖：严格输入校验（零/NaN/Infinity/非法 unit/非法 Date/非法货币代码）、
// 原子提交（异常时快照与调用前 deep-equal，无部分写入）、
// 成功直连更新（正/反向 middle/cash/remit、单位换算、买卖方向）、oneWay 跳过反向、
// CNY/CNH 别名写路径、mathjs Fraction 语义。
import fxManager from '../../src/fxm/fxManager';
import { currency, FXRate } from '../../src/types';

const VALID_DATE = new Date('2026-08-04T00:00:00Z');

const makeRate = (over: Partial<FXRate> = {}): FXRate =>
    ({
        currency: { from: 'USD' as currency.USD, to: 'CNY' as currency.CNY },
        rate: { middle: 7 },
        unit: 1,
        updated: VALID_DATE,
        ...over,
    }) as FXRate;

// 快照深拷贝：Fraction/Date 序列化为 JSON 后还原，用于 deep-equal 断言。
const snapshotClone = (m: fxManager): unknown =>
    JSON.parse(JSON.stringify(m.snapshot()));

describe('fxManager.update strict input validation', () => {
    const cases: { name: string; rate: FXRate }[] = [
        { name: 'zero middle', rate: makeRate({ rate: { middle: 0 } }) },
        {
            name: 'zero buy.cash',
            rate: makeRate({ rate: { buy: { cash: 0 }, middle: 7 } }),
        },
        {
            name: 'zero buy.remit',
            rate: makeRate({ rate: { buy: { remit: 0 }, middle: 7 } }),
        },
        {
            name: 'zero sell.cash',
            rate: makeRate({ rate: { sell: { cash: 0 }, middle: 7 } }),
        },
        {
            name: 'zero sell.remit',
            rate: makeRate({ rate: { sell: { remit: 0 }, middle: 7 } }),
        },
        { name: 'NaN middle', rate: makeRate({ rate: { middle: NaN } }) },
        {
            name: 'NaN buy.cash',
            rate: makeRate({ rate: { buy: { cash: NaN }, middle: 7 } }),
        },
        {
            name: 'NaN buy.remit',
            rate: makeRate({ rate: { buy: { remit: NaN }, middle: 7 } }),
        },
        {
            name: 'NaN sell.cash',
            rate: makeRate({ rate: { sell: { cash: NaN }, middle: 7 } }),
        },
        {
            name: 'NaN sell.remit',
            rate: makeRate({ rate: { sell: { remit: NaN }, middle: 7 } }),
        },
        {
            name: 'Infinity middle',
            rate: makeRate({ rate: { middle: Infinity } }),
        },
        {
            name: 'Infinity buy.cash',
            rate: makeRate({ rate: { buy: { cash: Infinity }, middle: 7 } }),
        },
        {
            name: 'Infinity buy.remit',
            rate: makeRate({ rate: { buy: { remit: Infinity }, middle: 7 } }),
        },
        {
            name: 'Infinity sell.cash',
            rate: makeRate({ rate: { sell: { cash: Infinity }, middle: 7 } }),
        },
        {
            name: 'Infinity sell.remit',
            rate: makeRate({ rate: { sell: { remit: Infinity }, middle: 7 } }),
        },
        { name: 'negative middle', rate: makeRate({ rate: { middle: -7 } }) },
        { name: 'zero unit', rate: makeRate({ unit: 0 }) },
        { name: 'NaN unit', rate: makeRate({ unit: NaN }) },
        { name: 'Infinity unit', rate: makeRate({ unit: Infinity }) },
        { name: 'negative unit', rate: makeRate({ unit: -1 }) },
        { name: 'string unit', rate: makeRate({ unit: '100' as never }) },
        {
            name: 'Invalid Date',
            rate: makeRate({ updated: new Date('invalid') }),
        },
        {
            name: 'NaN Date',
            rate: makeRate({ updated: new Date(NaN) }),
        },
        {
            name: 'string updated',
            rate: makeRate({ updated: '2026-08-04' as never }),
        },
        {
            name: 'lowercase currency',
            rate: makeRate({
                currency: {
                    from: 'usd' as currency,
                    to: 'CNY' as currency.CNY,
                },
            }),
        },
        {
            name: '2-letter currency',
            rate: makeRate({
                currency: { from: 'US' as currency, to: 'CNY' as currency.CNY },
            }),
        },
        {
            name: '4-letter currency',
            rate: makeRate({
                currency: {
                    from: 'USDT' as currency,
                    to: 'CNY' as currency.CNY,
                },
            }),
        },
        {
            name: 'empty currency from',
            rate: makeRate({
                currency: { from: '' as currency, to: 'CNY' as currency.CNY },
            }),
        },
        {
            name: 'currency.unknown value',
            rate: makeRate({
                currency: {
                    from: currency.unknown,
                    to: 'CNY' as currency.CNY,
                },
            }),
        },
        {
            name: 'missing currency object',
            rate: makeRate({ currency: undefined as never }),
        },
        {
            name: 'missing rate object',
            rate: makeRate({ rate: undefined as never }),
        },
        {
            // 数字字符串已被 update() 归一接受（见 numeric-string normalization 用例）；
            // 非数字字符串仍必须拒绝，保持原子回滚语义
            name: 'non-numeric string middle',
            rate: makeRate({ rate: { middle: 'abc' as never } }),
        },
    ];

    for (const { name, rate } of cases) {
        test(`${name} throws and leaves snapshot deep-equal to before`, () => {
            const m = new fxManager([
                makeRate({
                    currency: {
                        from: 'EUR' as currency.EUR,
                        to: 'CNY' as currency.CNY,
                    },
                    rate: { middle: 7.8 },
                }),
            ]);
            const before = snapshotClone(m);
            expect(() => m.update(rate)).toThrow();
            expect(snapshotClone(m)).toEqual(before);
        });
    }

    test('null FXRate is silently ignored', () => {
        const m = new fxManager([makeRate()]);
        const before = snapshotClone(m);
        m.update(null as unknown as FXRate);
        expect(snapshotClone(m)).toEqual(before);
    });

    test('no buy/sell/middle throws Invalid FXRate and leaves snapshot unchanged', () => {
        const m = new fxManager([makeRate()]);
        const before = snapshotClone(m);
        expect(() => m.update(makeRate({ rate: {} }))).toThrow(
            'Invalid FXRate',
        );
        expect(snapshotClone(m)).toEqual(before);
    });

    test('stale data (older updated) is ignored and leaves snapshot unchanged', () => {
        const m = new fxManager([makeRate()]);
        const before = snapshotClone(m);
        m.update(
            makeRate({
                rate: { middle: 9 },
                updated: new Date('2026-08-03T00:00:00Z'),
            }),
        );
        expect(snapshotClone(m)).toEqual(before);
    });
});

describe('fxManager.update successful direct update', () => {
    test('writes forward and reverse middle/cash/remit with Fraction semantics', async () => {
        const m = new fxManager([]);
        m.update(
            makeRate({
                rate: {
                    buy: { cash: 6.9, remit: 6.95 },
                    sell: { cash: 7.05, remit: 7.1 },
                    middle: 7,
                },
            }),
        );
        const fwd = await m.getfxRateList(currency.USD, currency.CNY);
        expect(Number(fwd?.middle)).toBe(7);
        expect(Number(fwd?.cash)).toBe(6.9);
        expect(Number(fwd?.remit)).toBe(6.95);
        const rev = await m.getfxRateList(currency.CNY, currency.USD);
        // 反向 = 1/rate（sell 方向）
        expect(Number(rev?.middle)).toBeCloseTo(1 / 7, 10);
        expect(Number(rev?.cash)).toBeCloseTo(1 / 7.05, 10);
        expect(Number(rev?.remit)).toBeCloseTo(1 / 7.1, 10);
    });

    test('unit scaling divides forward and reverse by unit', async () => {
        const m = new fxManager([]);
        m.update(
            makeRate({
                currency: {
                    from: 'JPY' as currency.JPY,
                    to: 'CNY' as currency.CNY,
                },
                rate: { middle: 700 },
                unit: 100,
            }),
        );
        const fwd = await m.getfxRateList(currency.JPY, currency.CNY);
        expect(Number(fwd?.middle)).toBe(7);
        const rev = await m.getfxRateList(currency.CNY, currency.JPY);
        expect(Number(rev?.middle)).toBeCloseTo(100 / 700, 10);
    });

    test('buy-only fills sell; sell-only fills buy; middle-only fills both', async () => {
        const buyOnly = new fxManager([]);
        buyOnly.update(
            makeRate({
                rate: { buy: { cash: 6.9 }, middle: 7 },
            }),
        );
        const fwdBuy = await buyOnly.getfxRateList(currency.USD, currency.CNY);
        expect(Number(fwdBuy?.cash)).toBe(6.9);
        // buy 只有 cash，remit 缺失 → 回落 cash（6.9）
        expect(Number(fwdBuy?.remit)).toBe(6.9);
        const revBuy = await buyOnly.getfxRateList(currency.CNY, currency.USD);
        // sell 复制 buy（cash=6.9），remit 缺失 → 回落 cash
        expect(Number(revBuy?.cash)).toBeCloseTo(1 / 6.9, 10);
        expect(Number(revBuy?.remit)).toBeCloseTo(1 / 6.9, 10);

        const sellOnly = new fxManager([]);
        sellOnly.update(
            makeRate({
                rate: { sell: { remit: 7.1 }, middle: 7 },
            }),
        );
        const fwdSell = await sellOnly.getfxRateList(
            currency.USD,
            currency.CNY,
        );
        // buy 复制 sell（remit=7.1），cash 缺失 → 回落 remit
        expect(Number(fwdSell?.cash)).toBe(7.1);
        expect(Number(fwdSell?.remit)).toBe(7.1);
        const revSell = await sellOnly.getfxRateList(
            currency.CNY,
            currency.USD,
        );
        expect(Number(revSell?.cash)).toBeCloseTo(1 / 7.1, 10);
        expect(Number(revSell?.remit)).toBeCloseTo(1 / 7.1, 10);

        const middleOnly = new fxManager([]);
        middleOnly.update(makeRate({ rate: { middle: 7 } }));
        const fwdMid = await middleOnly.getfxRateList(
            currency.USD,
            currency.CNY,
        );
        expect(Number(fwdMid?.cash)).toBe(7);
        expect(Number(fwdMid?.remit)).toBe(7);
        expect(Number(fwdMid?.middle)).toBe(7);
    });

    test('middle estimated from buy/sell min/max when absent', async () => {
        const m = new fxManager([]);
        m.update(
            makeRate({
                rate: {
                    buy: { cash: 6.9, remit: 6.95 },
                    sell: { cash: 7.05, remit: 7.1 },
                },
            }),
        );
        const fwd = await m.getfxRateList(currency.USD, currency.CNY);
        expect(Number(fwd?.middle)).toBeCloseTo((6.9 + 7.1) / 2, 10);
    });

    test('oneWay rate does not create a reverse edge', async () => {
        const m = new fxManager([]);
        m.update(makeRate({ oneWay: true }));
        const fwd = await m.getfxRateList(currency.USD, currency.CNY);
        expect(Number(fwd?.middle)).toBe(7);
        await expect(
            m.convert(currency.CNY, currency.USD, 'middle', 1),
        ).rejects.toThrow('No FX path found between CNY and USD');
    });

    test('newer update replaces older one and both directions update atomically', async () => {
        const m = new fxManager([]);
        m.update(makeRate({ rate: { middle: 7 } }));
        m.update(
            makeRate({
                rate: { middle: 7.2 },
                updated: new Date('2026-08-05T00:00:00Z'),
            }),
        );
        const fwd = await m.getfxRateList(currency.USD, currency.CNY);
        expect(Number(fwd?.middle)).toBeCloseTo(7.2, 10);
        const rev = await m.getfxRateList(currency.CNY, currency.USD);
        expect(Number(rev?.middle)).toBeCloseTo(1 / 7.2, 10);
    });
});

describe('fxManager.update CNY/CNH alias write semantics', () => {
    test('CNY to-key writes reverse edge into existing CNH node (alias preserved)', async () => {
        const m = new fxManager([]);
        m.update(
            makeRate({
                currency: {
                    from: 'EUR' as currency.EUR,
                    to: 'CNH' as currency.CNH,
                },
                rate: { middle: 7.6 },
            }),
        );
        // to=CNY，而图内只有 CNH 节点：反向边应落到 CNH 节点（别名写路径）
        m.update(makeRate({ rate: { middle: 7.1 } }));
        // 正向边按字面 to 存在 USD 节点上
        const fwd = m.fxRateList['USD' as currency.USD];
        expect(Number(fwd['CNY' as currency.CNY]?.middle)).toBeCloseTo(7.1, 10);
        // 反向边经别名解析落到 CNH 节点
        const cnh = m.fxRateList['CNH' as currency.CNH];
        expect(Number(cnh['USD' as currency.USD]?.middle)).toBeCloseTo(
            1 / 7.1,
            10,
        );
        // 读路径：CNY 别名解析到 CNH 节点
        const viaCny = await m.getfxRateList(currency.CNY, currency.USD);
        expect(Number(viaCny?.middle)).toBeCloseTo(1 / 7.1, 10);
    });

    test('CNY from-key writes forward edge into existing CNH node', async () => {
        const m = new fxManager([]);
        m.update(
            makeRate({
                currency: {
                    from: 'EUR' as currency.EUR,
                    to: 'CNH' as currency.CNH,
                },
                rate: { middle: 7.6 },
            }),
        );
        // from=CNY，图内只有 CNH 节点：正向边落到 CNH 节点
        m.update(
            makeRate({
                currency: {
                    from: 'CNY' as currency.CNY,
                    to: 'USD' as currency.USD,
                },
                rate: { middle: 7.2 },
            }),
        );
        const cnh = m.fxRateList['CNH' as currency.CNH];
        expect(Number(cnh['USD' as currency.USD]?.middle)).toBeCloseTo(7.2, 10);
        // 直连查询经别名解析成功
        const viaCny = await m.getfxRateList(currency.CNY, currency.USD);
        expect(Number(viaCny?.middle)).toBeCloseTo(7.2, 10);
    });

    test('CNY/CNH alias survives failed update (no partial CNH write)', () => {
        const m = new fxManager([]);
        m.update(
            makeRate({
                currency: {
                    from: 'EUR' as currency.EUR,
                    to: 'CNH' as currency.CNH,
                },
                rate: { middle: 7.6 },
            }),
        );
        const before = snapshotClone(m);
        // 以 CNY 为 to、NaN 中间价 → 校验抛错，不得污染 CNH 节点
        expect(() => m.update(makeRate({ rate: { middle: NaN } }))).toThrow();
        expect(snapshotClone(m)).toEqual(before);
        const eur = m.fxRateList['EUR' as currency.EUR];
        expect(eur).toBeDefined();
        expect(Number(eur['CNH' as currency.CNH]?.middle)).toBeCloseTo(7.6, 10);
    });
});

describe('fxManager.update numeric-string rate normalization', () => {
    test('string quote values are coerced to numbers and stored correctly', () => {
        const m = new fxManager([]);
        // 上游银行 API 常返回字符串报价（如 "673.4300"），getter 可能未转 number
        m.update(
            makeRate({
                rate: {
                    buy: {
                        cash: '6.85' as unknown as number,
                        remit: '6.9' as unknown as number,
                    },
                    sell: {
                        cash: '7.0' as unknown as number,
                        remit: '7.05' as unknown as number,
                    },
                    middle: '6.95' as unknown as number,
                },
            }),
        );
        const usd = m.fxRateList['USD' as currency.USD];
        expect(Number(usd['CNY' as currency.CNY]?.middle)).toBeCloseTo(
            6.95,
            10,
        );
        expect(Number(usd['CNY' as currency.CNY]?.cash)).toBeCloseTo(6.85, 10);
        expect(Number(usd['CNY' as currency.CNY]?.remit)).toBeCloseTo(6.9, 10);
    });

    test('non-numeric strings are still rejected (validation not weakened)', () => {
        const m = new fxManager([]);
        const before = snapshotClone(m);
        expect(() =>
            m.update(
                makeRate({
                    rate: {
                        buy: { cash: 'abc' as unknown as number },
                        middle: 7,
                    },
                }),
            ),
        ).toThrow(/Invalid FXRate/);
        expect(snapshotClone(m)).toEqual(before);
    });

    test('empty-string quote coerces to 0 and is rejected atomically', () => {
        const m = new fxManager([]);
        const before = snapshotClone(m);
        expect(() =>
            m.update(
                makeRate({
                    rate: { buy: { cash: '' as unknown as number }, middle: 7 },
                }),
            ),
        ).toThrow(/Invalid FXRate/);
        expect(snapshotClone(m)).toEqual(before);
    });
});
