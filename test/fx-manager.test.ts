import fxManager from '../src/fxm/fxManager';
import { currency, FXRate } from '../src/types.d';

test('oneWay rate does not create a reverse conversion path', async () => {
    const manager = new fxManager([
        {
            currency: {
                from: 'USD' as currency.USD,
                to: 'CNY' as currency.CNY,
            },
            rate: { middle: 7 },
            unit: 1,
            updated: new Date('2026-08-03T00:00:00Z'),
            oneWay: true,
        } as FXRate,
    ]);

    expect(
        Number(await manager.convert(currency.USD, currency.CNY, 'middle', 1)),
    ).toBe(7);
    await expect(
        manager.convert(currency.CNY, currency.USD, 'middle', 1),
    ).rejects.toThrow('No FX path found between CNY and USD');
    await expect(
        manager.getFXPath(currency.CNY, currency.USD, true),
    ).rejects.toThrow('No FX path found between CNY and USD');
});
