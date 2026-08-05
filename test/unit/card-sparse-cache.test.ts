// card-sparse-cache（Phase 5 稀疏类型化缓存，offline）：
// 验证替代「全量 N×N Proxy 矩阵 + JSON 字符串 LRU + 每字段 JSON.parse」的稀疏实现：
// 一、稀疏物化：访问 fxRateList 不物化任何行/单元格；Object.keys/in/truthiness 契约不变；
//     按需访问才递增 sparseRows/sparseCells（绝不全量构建 51k 单元格）。
// 二、typed LRU：正缓存存储 CardRate（Fraction + Date）而非 JSON 字符串；单元格字段读取
//     实时解析（live getter），未缓存/被淘汰时 undefined，二次读取零新增上游。
// 三、行为等价：直连路径（getFXPath）、CNH/CNY 别名 key 共享、hasUsableData、字段值正确。
// 零公网访问，可 --detectOpenHandles。

import { jest } from '@jest/globals';
import { fraction } from 'mathjs';
import { LRUCache } from 'lru-cache';
import { currency } from 'src/types.d';

import mastercardFXM, {
    mastercardCoordinator,
} from '../../src/FXGetter/mastercard';
import visaFXM, { visaCoordinator } from '../../src/FXGetter/visa';
import {
    createCardRateCellFactory,
    createCardSparseMatrix,
    type CardRate,
} from '../../src/FXGetter/cardCapacity';

const realFetch = globalThis.fetch;

const MASTERCARD_PAYLOAD = {
    data: { transAmt: '1', conversionRate: '7.5', fxDate: '2026-08-04' },
};

const VISA_PAYLOAD = {
    originalValues: { fxRateVisa: '7.2', lastUpdatedVisaRate: 1722729600 },
};

const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });

beforeEach(() => {
    globalThis.fetch = jest.fn(async () => jsonResponse(MASTERCARD_PAYLOAD));
    mastercardCoordinator.positive.clear();
    mastercardCoordinator.negative.clear();
    visaCoordinator.positive.clear();
    visaCoordinator.negative.clear();
});

afterEach(() => {
    globalThis.fetch = realFetch;
    jest.restoreAllMocks();
});

describe('sparse matrix materialization (no dense 51k cells)', () => {
    test('accessing fxRateList does not materialize rows or cells', () => {
        const fxm = new mastercardFXM();
        expect(fxm.sparseRows).toBe(0);
        expect(fxm.sparseCells).toBe(0);
        void fxm.fxRateList;
        expect(fxm.sparseRows).toBe(0);
        expect(fxm.sparseCells).toBe(0);
    });

    test('Object.keys returns all supported currencies without materializing', () => {
        const fxm = new mastercardFXM();
        const keys = Object.keys(fxm.fxRateList);
        expect(keys.length).toBeGreaterThan(100);
        expect(keys).toContain('USD');
        expect(keys).toContain('CNH');
        expect(fxm.sparseRows).toBe(0);
        expect(fxm.sparseCells).toBe(0);
    });

    test('in operator is true for supported and false for unknown currencies', () => {
        const fxm = new mastercardFXM();
        expect('USD' in fxm.fxRateList).toBe(true);
        expect('CNY' in fxm.fxRateList).toBe(true);
        expect('XXX' in fxm.fxRateList).toBe(false);
        expect(fxm.sparseRows).toBe(0);
    });

    test('rows and cells materialize only on access', () => {
        const fxm = new mastercardFXM();
        const row = fxm.fxRateList['USD'];
        expect(row).toBeDefined();
        expect(fxm.sparseRows).toBe(1);
        expect(fxm.sparseCells).toBe(0);
        const cell = row['CNY'];
        expect(cell).toBeDefined();
        expect(fxm.sparseRows).toBe(1);
        expect(fxm.sparseCells).toBe(1);
        // 同一行内第二个 pair 只新增单元格
        expect(fxm.fxRateList['USD']['EUR']).toBeDefined();
        expect(fxm.sparseRows).toBe(1);
        expect(fxm.sparseCells).toBe(2);
    });

    test('row Object.keys returns all currencies (BFS neighbor contract)', () => {
        const fxm = new mastercardFXM();
        const row = fxm.fxRateList['USD'];
        expect('CNY' in row).toBe(true);
        expect('XXX' in row).toBe(false);
        const keys = Object.keys(row);
        expect(keys).toContain('CNY');
        expect(keys.length).toBe(Object.keys(fxm.fxRateList).length);
        expect(fxm.sparseCells).toBe(0);
    });

    test('unknown currency access returns undefined and materializes nothing', () => {
        const fxm = new mastercardFXM();
        expect(fxm.fxRateList['XXX']).toBeUndefined();
        expect(fxm.fxRateList['USD']['XXX']).toBeUndefined();
        expect(fxm.sparseRows).toBe(1);
        expect(fxm.sparseCells).toBe(0);
    });
});

describe('typed positive cache (CardRate, no JSON strings)', () => {
    test('successful fetch stores a typed CardRate, not a JSON string', async () => {
        const fxm = new mastercardFXM();
        await fxm.getfxRateList(currency.USD, currency.CNY);
        const stored = mastercardCoordinator.positive.get('USDCNY');
        expect(stored).toBeDefined();
        expect(typeof stored).toBe('object');
        expect(stored?.updated).toBeInstanceOf(Date);
        expect(Number(stored?.middle)).toBeCloseTo(1 / 7.5, 10);
        expect(mastercardCoordinator.positive.max).toBe(500);
        expect(mastercardCoordinator.positive.ttl).toBe(1000 * 60 * 30);
    });

    test('cell fields resolve from the typed cache without further upstream work', async () => {
        const fxm = new mastercardFXM();
        const rate = await fxm.getfxRateList(currency.USD, currency.CNY);
        const fetchCalls = (globalThis.fetch as ReturnType<typeof jest.fn>).mock
            .calls.length;
        expect(Number(rate?.middle)).toBeCloseTo(1 / 7.5, 10);
        expect(Number(rate?.cash)).toBeCloseTo(1 / 7.5, 10);
        expect(Number(rate?.remit)).toBeCloseTo(1 / 7.5, 10);
        expect(rate?.updated).toBeInstanceOf(Date);
        // 重复字段读取稳定且零上游
        expect(Number(rate?.middle)).toBeCloseTo(1 / 7.5, 10);
        expect(
            (globalThis.fetch as ReturnType<typeof jest.fn>).mock.calls.length,
        ).toBe(fetchCalls);
    });

    test('uncached cell fields are undefined but the cell is truthy (direct path)', async () => {
        const fxm = new mastercardFXM();
        const cell = fxm.fxRateList['USD']['CNY'];
        expect(cell).toBeTruthy();
        expect(cell.middle).toBeUndefined();
        expect(cell.updated).toBeUndefined();
        expect(fxm.hasUsableData()).toBe(false);
    });

    test('cell is a live view: value appears after cache write and disappears after eviction', async () => {
        const cache = new LRUCache<string, CardRate>({ max: 1 });
        const cellForKey = createCardRateCellFactory(cache);
        const cell = cellForKey('USDCNY');
        expect(cell.middle).toBeUndefined();
        cache.set('USDCNY', {
            middle: fraction(7),
            cash: fraction(7),
            remit: fraction(7),
            updated: new Date('2026-08-04T00:00:00Z'),
        });
        expect(Number(cell.middle)).toBeCloseTo(7, 10);
        // max=1 淘汰旧 key 后字段回落 undefined
        cache.set('EURCNY', {
            middle: fraction(8),
            cash: fraction(8),
            remit: fraction(8),
            updated: new Date(),
        });
        expect(cell.middle).toBeUndefined();
    });

    test('createCardSparseMatrix aliases CNH/CNY to the same normalized cache key', () => {
        const cache = new LRUCache<string, CardRate>({ max: 10 });
        const matrix = createCardSparseMatrix(
            ['USD', 'CNY', 'CNH'],
            cache,
            (code) => (code === 'CNH' ? 'CNY' : code),
        );
        cache.set('CNYUSD', {
            middle: fraction('0.14'),
            cash: fraction('0.14'),
            remit: fraction('0.14'),
            updated: new Date(),
        });
        expect(Number(matrix['CNY']['USD'].middle)).toBeCloseTo(0.14, 10);
        expect(Number(matrix['CNH']['USD'].middle)).toBeCloseTo(0.14, 10);
        expect(matrix['CNH']['USD']).not.toBe(matrix['CNY']['USD']);
    });

    test('hasUsableData reflects the typed cache size', async () => {
        const fxm = new mastercardFXM();
        expect(fxm.hasUsableData()).toBe(false);
        await fxm.getfxRateList(currency.USD, currency.CNY);
        expect(fxm.hasUsableData()).toBe(true);
    });

    test('getFXPath returns a direct path for an in-list pair without upstream work', async () => {
        const fxm = new mastercardFXM();
        const path = await fxm.getFXPath(currency.USD, currency.CNY, false);
        expect(path.path).toEqual([currency.CNY]);
        expect(
            (globalThis.fetch as ReturnType<typeof jest.fn>).mock.calls,
        ).toHaveLength(0);
    });
});

describe('visa sparse cache (chromium fallback preserved)', () => {
    test('native success stores typed CardRate and fields resolve', async () => {
        (globalThis.fetch as ReturnType<typeof jest.fn>).mockImplementation(
            async () => jsonResponse(VISA_PAYLOAD),
        );
        const fxm = new visaFXM();
        const rate = await fxm.getfxRateList(currency.USD, currency.CNY);
        expect(Number(rate?.middle)).toBeCloseTo(7.2, 10);
        expect(visaCoordinator.positive.get('USDCNY')?.updated).toBeInstanceOf(
            Date,
        );
        // 稀疏契约同 mastercard
        expect(fxm.sparseRows).toBe(1);
        expect(fxm.sparseCells).toBe(1);
    });
});
