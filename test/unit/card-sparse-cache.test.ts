// card-sparse-cache（Phase 5 稀疏类型化缓存，offline）：
// 验证替代「全量 N×N Proxy 矩阵 + JSON 字符串 LRU + 每字段 JSON.parse」的稀疏实现：
// 一、稀疏物化：访问 fxRateList 不物化任何行/单元格；Object.keys/in/truthiness 契约不变；
//     按需访问才递增 sparseRows/sparseCells（绝不全量构建 51k 单元格）。
// 二、typed LRU：正缓存存储 CardRate（Fraction + Date）而非 JSON 字符串；单元格字段读取
//     实时解析（live getter），未缓存/被淘汰时 undefined，二次读取零新增上游。
// 三、行为等价：直连路径（getFXPath）、CNH/CNY 别名 key 共享、hasUsableData、字段值正确。
// 四、评审修复（Phase 5 review remediation）：稀疏单元格反射语义与旧密集 Proxy cell 一致
//     （Object.keys/getOwnPropertyNames/JSON.stringify 空对象、自定义/符号属性 undefined）；
//     矩阵/行 Proxy 在 preventExtensions/freeze 后不违反不变式；字段读取返回克隆
//     （改动返回值不污染缓存）；写正缓存前经 validateCardRate 最终校验，畸形 payload
//     只进负缓存；FXRATE_CARD_DENSE_MATRIX=1 回退全量 typed 密集矩阵。
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
    createCardMatrix,
    createCardDenseMatrix,
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

describe('sparse cell reflection parity (old dense Proxy cell semantics)', () => {
    test('Object.keys / getOwnPropertyNames / JSON.stringify behave like the old dense cell', () => {
        const fxm = new mastercardFXM();
        const cell = fxm.fxRateList['USD']['CNY'];
        // 旧密集实现 cell 是「仅 get trap 的 Proxy over {}」：反射为空对象语义。
        expect(Object.keys(cell)).toEqual([]);
        expect(Object.getOwnPropertyNames(cell)).toEqual([]);
        expect(JSON.stringify(cell)).toBe('{}');
        expect({ ...cell }).toEqual({});
        expect(fxm.sparseCells).toBe(1);
    });

    test('custom / symbol / then properties read as undefined (no Promise/thenable leak)', () => {
        const fxm = new mastercardFXM();
        const cell = fxm.fxRateList['USD']['CNY'] as unknown as Record<
            PropertyKey,
            unknown
        >;
        expect(cell['customProp']).toBeUndefined();
        expect(cell[Symbol.iterator]).toBeUndefined();
        expect(cell[Symbol.toPrimitive]).toBeUndefined();
        expect(cell['then']).toBeUndefined();
        expect(cell['toJSON']).toBeUndefined();
        // old dense cell 的 get trap 忽略 target 赋值：写入后读取仍为 undefined，
        // 赋值只经 Object.keys / descriptor 可见（普通对象反射语义）。
        cell['customProp'] = 42;
        expect(cell['customProp']).toBeUndefined();
        expect(cell['middle']).toBeUndefined();
        expect(Object.keys(cell)).toEqual(['customProp']);
        expect(Object.getOwnPropertyDescriptor(cell, 'customProp')?.value).toBe(
            42,
        );
    });

    test('assigned quote fields do not override the cached/undefined getter', async () => {
        const fxm = new mastercardFXM();
        await fxm.getfxRateList(currency.USD, currency.CNY);
        const cell = fxm.fxRateList['USD']['CNY'] as unknown as Record<
            PropertyKey,
            unknown
        >;
        const before = Number(cell['middle']);
        cell['middle'] = fraction('999');
        // 赋值不覆盖 live 缓存读取（old dense cell 同语义）
        expect(Number(cell['middle'])).toBeCloseTo(1 / 7.5, 10);
        expect(before).toBeCloseTo(1 / 7.5, 10);
        // 未缓存 pair：赋值后读取仍为 undefined
        const empty = fxm.fxRateList['USD']['EUR'] as unknown as Record<
            PropertyKey,
            unknown
        >;
        expect(empty['cash']).toBeUndefined();
        empty['cash'] = fraction('999');
        expect(empty['cash']).toBeUndefined();
        // 赋值经 descriptor 可见
        expect(
            Object.getOwnPropertyDescriptor(empty, 'cash')?.value,
        ).toBeDefined();
    });

    test('non-configurable data property invariant returns the exact value', () => {
        const fxm = new mastercardFXM();
        const cell = fxm.fxRateList['USD']['CNY'];
        const sentinel = fraction('5.5');
        Object.defineProperty(cell, 'middle', {
            value: sentinel,
            writable: false,
            configurable: false,
        });
        // Proxy 不变式：非可写非配置数据属性必须返回精确值
        expect(cell.middle).toBe(sentinel);
    });

    test('materialized row/currency own descriptors report the real value', () => {
        const fxm = new mastercardFXM();
        const matrix = fxm.fxRateList;
        const usdRow = matrix['USD'];
        const desc = Object.getOwnPropertyDescriptor(matrix, 'USD');
        expect(desc?.value).toBe(usdRow);
        expect(usdRow['CNY']).toBeDefined();
        // 已支持但未物化的货币：访问器描述符（读取/展开拿到真实 row，枚举不触发物化），
        // 未知货币为 undefined
        const pending = Object.getOwnPropertyDescriptor(matrix, 'EUR');
        expect(pending?.configurable).toBe(true);
        expect(pending?.enumerable).toBe(true);
        expect(typeof pending?.get).toBe('function');
        const pendingRow = pending!.get!.call(matrix);
        expect(pendingRow).toBeDefined();
        expect(pendingRow).toBe(matrix['EUR']);
        expect(Object.getOwnPropertyDescriptor(matrix, 'XXX')).toBeUndefined();
    });

    test('spread over the matrix yields one entry per supported currency', () => {
        const fxm = new mastercardFXM();
        const copy: Record<string, unknown> = { ...fxm.fxRateList };
        const currencies = Object.keys(fxm.fxRateList);
        expect(Object.keys(copy).length).toBe(currencies.length);
        // 展开经访问器描述符取值：拿到的是真实 row（与旧密集矩阵一致）
        expect(copy['USD']).toBe(fxm.fxRateList['USD']);
    });
});

describe('sparse matrix Proxy invariants under non-extensible operations', () => {
    test('preventExtensions materializes remaining currencies and keeps Object.keys full', () => {
        const fxm = new mastercardFXM();
        const matrix = fxm.fxRateList;
        const usdRow = matrix['USD']; // 先物化一行
        const currencies = Object.keys(matrix);
        expect(currencies.length).toBeGreaterThan(100);
        Object.preventExtensions(matrix);
        // 防扩展先物化全部未删除支持货币：Object.keys 保持全量（同旧密集矩阵），不抛 TypeError
        expect(() => Object.keys(matrix)).not.toThrow();
        expect(Object.keys(matrix).length).toBe(currencies.length);
        expect(matrix['USD']).toBe(usdRow);
        expect(matrix['EUR']).toBeDefined();
        expect(matrix['XXX']).toBeUndefined();
        expect(fxm.sparseRows).toBe(currencies.length);
    });

    test('freeze matrix keeps full keys and materialized reads working', () => {
        const fxm = new mastercardFXM();
        const matrix = fxm.fxRateList;
        const currencies = Object.keys(matrix);
        Object.freeze(matrix);
        expect(() => Object.keys(matrix)).not.toThrow();
        expect(Object.keys(matrix).length).toBe(currencies.length);
        expect('USD' in matrix).toBe(true);
        expect('XXX' in matrix).toBe(false);
        // 冻结后单元格仍可读（行是子 Proxy，冻结矩阵不深冻结行），未缓存字段为 undefined
        expect(matrix['USD']['CNY']).toBeDefined();
        expect(matrix['USD']['CNY'].middle).toBeUndefined();
        // freeze 收紧虚拟键前先物化：冻结后未访问过的货币仍返回真实 row
        expect(matrix['EUR']).toBeDefined();
    });

    test('preventExtensions on a materialized row keeps full row keys', () => {
        const fxm = new mastercardFXM();
        const row = fxm.fxRateList['USD'];
        const cell = row['CNY'];
        const currencies = Object.keys(row);
        expect(currencies.length).toBeGreaterThan(100);
        Object.preventExtensions(row);
        expect(() => Object.keys(row)).not.toThrow();
        expect(Object.keys(row).length).toBe(currencies.length);
        expect(row['CNY']).toBe(cell);
        expect(row['EUR']).toBeDefined();
        expect(row['XXX']).toBeUndefined();
    });
});

describe('sparse matrix old-object differential semantics', () => {
    test('inherited properties delegate to the prototype like a plain object', () => {
        const fxm = new mastercardFXM();
        const matrix = fxm.fxRateList;
        expect(matrix.toString).toBe(Object.prototype.toString);
        expect(matrix.hasOwnProperty).toBe(Object.prototype.hasOwnProperty);
        expect(matrix.constructor).toBe(Object);
        expect('toString' in matrix).toBe(true);
        expect('constructor' in matrix).toBe(true);
        expect(matrix['valueOf']).toBe(Object.prototype.valueOf);
        const row = matrix['USD'];
        expect(row.toString).toBe(Object.prototype.toString);
        expect(row.constructor).toBe(Object);
        expect('constructor' in row).toBe(true);
    });

    test('deleting a supported currency omits it from get/has/ownKeys until restored', () => {
        const fxm = new mastercardFXM();
        const matrix = fxm.fxRateList;
        const usdRow = matrix['USD']; // 物化后删除
        const keysBefore = Object.keys(matrix);
        expect('USD' in matrix).toBe(true);
        expect(delete matrix['USD']).toBe(true);
        expect('USD' in matrix).toBe(false);
        expect(Object.keys(matrix).length).toBe(keysBefore.length - 1);
        expect(matrix['USD']).toBeUndefined();
        expect(matrix['USD']).not.toBe(usdRow);
        // 未物化货币删除同样省略
        expect('EUR' in matrix).toBe(true);
        expect(delete matrix['EUR']).toBe(true);
        expect('EUR' in matrix).toBe(false);
        expect(matrix['EUR']).toBeUndefined();
        expect(Object.keys(matrix).length).toBe(keysBefore.length - 2);
    });

    test('set and defineProperty restore a deleted currency', () => {
        const fxm = new mastercardFXM();
        const matrix = fxm.fxRateList;
        const keysBefore = Object.keys(matrix);
        delete matrix['USD'];
        delete matrix['EUR'];
        // set 恢复
        matrix['USD'] = matrix['CNY'];
        expect('USD' in matrix).toBe(true);
        expect(matrix['USD']).toBeDefined();
        // defineProperty 恢复
        Object.defineProperty(matrix, 'EUR', {
            value: matrix['CNY'],
            writable: true,
            configurable: true,
            enumerable: true,
        });
        expect('EUR' in matrix).toBe(true);
        expect(matrix['EUR']).toBeDefined();
        expect(Object.keys(matrix).length).toBe(keysBefore.length);
    });

    test('row-level delete/set behaves the same', () => {
        const fxm = new mastercardFXM();
        const row = fxm.fxRateList['USD'];
        const cnyCell = row['CNY'];
        expect('CNY' in row).toBe(true);
        expect(delete row['CNY']).toBe(true);
        expect('CNY' in row).toBe(false);
        expect(row['CNY']).toBeUndefined();
        expect(row['CNY']).not.toBe(cnyCell);
        row['CNY'] = row['HKD'];
        expect('CNY' in row).toBe(true);
        expect(row['CNY']).toBeDefined();
    });

    test('failed set on a non-extensible matrix does not resurrect a deleted currency', () => {
        const fxm = new mastercardFXM();
        const matrix = fxm.fxRateList;
        const usdRow = matrix['USD'];
        expect(delete matrix['USD']).toBe(true);
        Object.preventExtensions(matrix);
        expect('USD' in matrix).toBe(false);
        expect(matrix['USD']).toBeUndefined();
        // 严格模式赋值必须抛 TypeError（与旧普通对象一致），且绝不能把 in 恢复为 true
        // （否则出现 in=true 但读取 undefined 的不一致状态）
        expect(() => {
            matrix['USD'] = usdRow;
        }).toThrow(TypeError);
        expect('USD' in matrix).toBe(false);
        expect(matrix['USD']).toBeUndefined();
        expect(Object.keys(matrix)).not.toContain('USD');
    });

    test('user-defined accessor properties receive the proxy as this', () => {
        const fxm = new mastercardFXM();
        const matrix = fxm.fxRateList as unknown as Record<string, unknown>;
        const probe: { getterThis?: unknown; setterThis?: unknown } = {};
        Object.defineProperty(matrix, 'CUSTOM', {
            configurable: true,
            enumerable: true,
            get() {
                probe.getterThis = this;
                return 42;
            },
            set() {
                probe.setterThis = this;
            },
        });
        expect(matrix['CUSTOM']).toBe(42);
        expect(probe.getterThis).toBe(matrix);
        matrix['CUSTOM'] = 7;
        expect(probe.setterThis).toBe(matrix);
        // 支持货币键上的访问器同样保持 this === proxy；getter-only 赋值抛 TypeError
        Object.defineProperty(matrix, 'EUR', {
            configurable: true,
            enumerable: true,
            get() {
                probe.getterThis = this;
                return 'eur-value';
            },
        });
        expect(matrix['EUR']).toBe('eur-value');
        expect(probe.getterThis).toBe(matrix);
        expect(() => {
            matrix['EUR'] = 1;
        }).toThrow(TypeError);
    });

    test('custom symbol and non-configurable properties keep working', () => {
        const fxm = new mastercardFXM();
        const row = fxm.fxRateList['USD'] as unknown as Record<
            PropertyKey,
            unknown
        >;
        const tag = Symbol('custom');
        row[tag] = 'hello';
        expect(row[tag]).toBe('hello');
        expect(Reflect.ownKeys(row)).toContain(tag);
        // 非配置数据属性：get 返回精确值、delete 失败
        const sentinel = { value: 1 };
        Object.defineProperty(row, 'USD', {
            value: sentinel,
            writable: false,
            configurable: false,
        });
        expect(row['USD']).toBe(sentinel);
        expect(Reflect.deleteProperty(row, 'USD')).toBe(false);
        expect('USD' in row).toBe(true);
        // 冻结行后 ownKeys 不再抛不变式 TypeError
        const row2 = fxm.fxRateList['EUR'];
        Object.freeze(row2);
        expect(() => Object.keys(row2)).not.toThrow();
    });
});

describe('read clones isolate consumers from the typed cache', () => {
    test('mutating a returned middle Fraction does not corrupt the cache', async () => {
        const fxm = new mastercardFXM();
        await fxm.getfxRateList(currency.USD, currency.CNY);
        const rate = fxm.fxRateList['USD']['CNY'];
        const middle = rate.middle;
        middle.n = 999999; // 消费者意外修改返回值
        const cached = mastercardCoordinator.positive.get('USDCNY');
        expect(Number(cached?.middle)).toBeCloseTo(1 / 7.5, 10);
        expect(Number(fxm.fxRateList['USD']['CNY'].middle)).toBeCloseTo(
            1 / 7.5,
            10,
        );
    });

    test('mutating a returned updated Date does not corrupt the cache', async () => {
        const fxm = new mastercardFXM();
        await fxm.getfxRateList(currency.USD, currency.CNY);
        const rate = fxm.fxRateList['USD']['CNY'];
        (rate.updated as Date).setUTCFullYear(1999);
        expect(
            mastercardCoordinator.positive
                .get('USDCNY')
                ?.updated.getUTCFullYear(),
        ).toBe(2026);
    });

    test('each read returns a fresh clone (no shared reference)', () => {
        const cache = new LRUCache<string, CardRate>({ max: 10 });
        cache.set('USDCNY', {
            middle: fraction('7.25'),
            cash: fraction('7.25'),
            remit: fraction('7.25'),
            updated: new Date('2026-08-04T00:00:00Z'),
        });
        const cellForKey = createCardRateCellFactory(cache);
        const cell = cellForKey('USDCNY');
        const cached = cache.get('USDCNY');
        expect(cell.middle).not.toBe(cached?.middle);
        expect(cell.updated).not.toBe(cached?.updated);
        expect(cell.middle).not.toBe(cell.middle);
        expect(cell.updated).not.toBe(cell.updated);
    });
});

describe('final CardRate validation gates the positive cache (malformed → negative only)', () => {
    test('mastercard missing fxDate enters negative cache (never epoch)', async () => {
        (globalThis.fetch as ReturnType<typeof jest.fn>).mockImplementation(
            async () =>
                jsonResponse({
                    data: {
                        transAmt: '1',
                        conversionRate: '7.5',
                        // fxDate 缺失
                    },
                }),
        );
        const fxm = new mastercardFXM();
        await expect(
            fxm.getfxRateList(currency.USD, currency.CNY),
        ).rejects.toThrow(/updated/);
        expect(mastercardCoordinator.positive.has('USDCNY')).toBe(false);
        expect(
            mastercardCoordinator.negative.blocked('mastercard:USD:CNY'),
        ).toBeDefined();
    });

    test('mastercard empty fxDate enters negative cache (never epoch)', async () => {
        (globalThis.fetch as ReturnType<typeof jest.fn>).mockImplementation(
            async () =>
                jsonResponse({
                    data: {
                        transAmt: '1',
                        conversionRate: '7.5',
                        fxDate: '',
                    },
                }),
        );
        const fxm = new mastercardFXM();
        await expect(
            fxm.getfxRateList(currency.USD, currency.CNY),
        ).rejects.toThrow(/updated/);
        expect(mastercardCoordinator.positive.has('USDCNY')).toBe(false);
    });

    test('mastercard invalid fxDate enters negative cache and never positive', async () => {
        (globalThis.fetch as ReturnType<typeof jest.fn>).mockImplementation(
            async () =>
                jsonResponse({
                    data: {
                        transAmt: '1',
                        conversionRate: '7.5',
                        fxDate: 'not-a-date',
                    },
                }),
        );
        const fxm = new mastercardFXM();
        await expect(
            fxm.getfxRateList(currency.USD, currency.CNY),
        ).rejects.toThrow(/updated/);
        expect(mastercardCoordinator.positive.has('USDCNY')).toBe(false);
        expect(
            mastercardCoordinator.negative.blocked('mastercard:USD:CNY'),
        ).toBeDefined();
    });

    test('mastercard zero conversionRate (division by zero) enters negative cache', async () => {
        (globalThis.fetch as ReturnType<typeof jest.fn>).mockImplementation(
            async () =>
                jsonResponse({
                    data: {
                        transAmt: '1',
                        conversionRate: '0',
                        fxDate: '2026-08-04',
                    },
                }),
        );
        const fxm = new mastercardFXM();
        await expect(
            fxm.getfxRateList(currency.USD, currency.CNY),
        ).rejects.toThrow();
        expect(mastercardCoordinator.positive.has('USDCNY')).toBe(false);
        expect(
            mastercardCoordinator.negative.blocked('mastercard:USD:CNY'),
        ).toBeDefined();
    });

    test('mastercard negative transAmt yields negative rate → rejected', async () => {
        (globalThis.fetch as ReturnType<typeof jest.fn>).mockImplementation(
            async () =>
                jsonResponse({
                    data: {
                        transAmt: '-1',
                        conversionRate: '7.5',
                        fxDate: '2026-08-04',
                    },
                }),
        );
        const fxm = new mastercardFXM();
        await expect(
            fxm.getfxRateList(currency.USD, currency.CNY),
        ).rejects.toThrow(/positive fraction/);
        expect(mastercardCoordinator.positive.has('USDCNY')).toBe(false);
    });

    test('visa NaN fxRateVisa enters negative cache', async () => {
        (globalThis.fetch as ReturnType<typeof jest.fn>).mockImplementation(
            async () =>
                jsonResponse({
                    originalValues: {
                        fxRateVisa: 'abc',
                        lastUpdatedVisaRate: 1722729600,
                    },
                }),
        );
        const fxm = new visaFXM();
        await expect(
            fxm.getfxRateList(currency.USD, currency.CNY),
        ).rejects.toThrow();
        expect(visaCoordinator.positive.has('USDCNY')).toBe(false);
        expect(visaCoordinator.negative.blocked('visa:USD:CNY')).toBeDefined();
    });

    test('visa missing lastUpdatedVisaRate enters negative cache (never epoch/now)', async () => {
        (globalThis.fetch as ReturnType<typeof jest.fn>).mockImplementation(
            async () =>
                jsonResponse({
                    originalValues: {
                        fxRateVisa: '7.2',
                        // lastUpdatedVisaRate 缺失
                    },
                }),
        );
        const fxm = new visaFXM();
        await expect(
            fxm.getfxRateList(currency.USD, currency.CNY),
        ).rejects.toThrow(/updated/);
        expect(visaCoordinator.positive.has('USDCNY')).toBe(false);
        expect(visaCoordinator.negative.blocked('visa:USD:CNY')).toBeDefined();
    });

    test('visa non-finite lastUpdatedVisaRate enters negative cache', async () => {
        (globalThis.fetch as ReturnType<typeof jest.fn>).mockImplementation(
            async () =>
                jsonResponse({
                    originalValues: {
                        fxRateVisa: '7.2',
                        lastUpdatedVisaRate: Infinity,
                    },
                }),
        );
        const fxm = new visaFXM();
        await expect(
            fxm.getfxRateList(currency.USD, currency.CNY),
        ).rejects.toThrow(/updated/);
        expect(visaCoordinator.positive.has('USDCNY')).toBe(false);
    });

    test('visa negative lastUpdatedVisaRate enters negative cache', async () => {
        (globalThis.fetch as ReturnType<typeof jest.fn>).mockImplementation(
            async () =>
                jsonResponse({
                    originalValues: {
                        fxRateVisa: '7.2',
                        lastUpdatedVisaRate: -100,
                    },
                }),
        );
        const fxm = new visaFXM();
        await expect(
            fxm.getfxRateList(currency.USD, currency.CNY),
        ).rejects.toThrow(/updated/);
        expect(visaCoordinator.positive.has('USDCNY')).toBe(false);
    });

    test('visa invalid lastUpdatedVisaRate enters negative cache (no now() substitution)', async () => {
        (globalThis.fetch as ReturnType<typeof jest.fn>).mockImplementation(
            async () =>
                jsonResponse({
                    originalValues: {
                        fxRateVisa: '7.2',
                        lastUpdatedVisaRate: 'garbage',
                    },
                }),
        );
        const fxm = new visaFXM();
        await expect(
            fxm.getfxRateList(currency.USD, currency.CNY),
        ).rejects.toThrow(/updated/);
        expect(visaCoordinator.positive.has('USDCNY')).toBe(false);
        expect(visaCoordinator.negative.blocked('visa:USD:CNY')).toBeDefined();
    });

    test('visa zero fxRateVisa is a valid object but a zero quote → rejected', async () => {
        (globalThis.fetch as ReturnType<typeof jest.fn>).mockImplementation(
            async () =>
                jsonResponse({
                    originalValues: {
                        fxRateVisa: '0',
                        lastUpdatedVisaRate: 1722729600,
                    },
                }),
        );
        const fxm = new visaFXM();
        await expect(
            fxm.getfxRateList(currency.USD, currency.CNY),
        ).rejects.toThrow(/positive fraction/);
        expect(visaCoordinator.positive.has('USDCNY')).toBe(false);
    });

    test('future updated Date is rejected before positive cache write', async () => {
        (globalThis.fetch as ReturnType<typeof jest.fn>).mockImplementation(
            async () =>
                jsonResponse({
                    data: {
                        transAmt: '1',
                        conversionRate: '7.5',
                        // 晚于 now + 5min 偏差：视为伪造/时钟偏移
                        fxDate: new Date(
                            Date.now() + 60 * 60 * 1000,
                        ).toISOString(),
                    },
                }),
        );
        const fxm = new mastercardFXM();
        await expect(
            fxm.getfxRateList(currency.USD, currency.CNY),
        ).rejects.toThrow(/future/);
        expect(mastercardCoordinator.positive.has('USDCNY')).toBe(false);
    });
});

describe('FXRATE_CARD_DENSE_MATRIX rollback flag (default sparse)', () => {
    const DENSE_FLAG = 'FXRATE_CARD_DENSE_MATRIX';
    const original = process.env[DENSE_FLAG];

    afterEach(() => {
        if (original === undefined) {
            delete process.env[DENSE_FLAG];
        } else {
            process.env[DENSE_FLAG] = original;
        }
    });

    test('flag unset: createCardMatrix builds the sparse matrix', () => {
        delete process.env[DENSE_FLAG];
        const cache = new LRUCache<string, CardRate>({ max: 10 });
        const stats = { rows: 0, cells: 0 };
        const matrix = createCardMatrix(
            ['USD', 'CNY', 'EUR'],
            cache,
            (code) => (code === 'CNH' ? 'CNY' : code),
            stats,
        );
        expect(Object.keys(matrix).length).toBe(3);
        expect(stats.rows).toBe(0);
        expect(stats.cells).toBe(0);
    });

    test('flag=1: dense typed matrix materializes every row and cell up front', () => {
        process.env[DENSE_FLAG] = '1';
        const cache = new LRUCache<string, CardRate>({ max: 10 });
        const matrix = createCardMatrix(['USD', 'CNY', 'EUR'], cache, (code) =>
            code === 'CNH' ? 'CNY' : code,
        );
        const currencies = Object.keys(matrix);
        expect(currencies).toEqual(['USD', 'CNY', 'EUR']);
        expect(Object.getOwnPropertyNames(matrix).length).toBe(3);
        // 每行每格都是真实自有属性，无需访问即存在
        const row = matrix['USD'];
        expect(Object.keys(row).length).toBe(3);
        expect(row['CNY']).toBeDefined();
        expect(row['EUR']).toBeDefined();
    });

    test('flag=1: FXM instance uses the dense typed matrix sharing the typed cache', async () => {
        process.env[DENSE_FLAG] = '1';
        const fxm = new mastercardFXM();
        const rate = await fxm.getfxRateList(currency.USD, currency.CNY);
        expect(Number(rate?.middle)).toBeCloseTo(1 / 7.5, 10);
        expect(fxm.sparseRows).toBe(0);
        expect(fxm.sparseCells).toBe(0);
        // 反射/克隆契约与稀疏一致
        const cell = fxm.fxRateList['USD']['CNY'];
        expect(Object.keys(cell)).toEqual([]);
        cell.middle.n = 1; // 改动克隆不影响缓存
        expect(Number(fxm.fxRateList['USD']['CNY'].middle)).toBeCloseTo(
            1 / 7.5,
            10,
        );
    });

    test('createCardDenseMatrix exposes all cells and reads the typed cache', () => {
        const cache = new LRUCache<string, CardRate>({ max: 10 });
        cache.set('CNYUSD', {
            middle: fraction('0.14'),
            cash: fraction('0.14'),
            remit: fraction('0.14'),
            updated: new Date('2026-08-04T00:00:00Z'),
        });
        const matrix = createCardDenseMatrix(
            ['USD', 'CNY', 'CNH'],
            cache,
            (code) => (code === 'CNH' ? 'CNY' : code),
        );
        expect(Object.keys(matrix['USD']).length).toBe(3);
        expect(Number(matrix['CNY']['USD'].middle)).toBeCloseTo(0.14, 10);
        expect(Number(matrix['CNH']['USD'].middle)).toBeCloseTo(0.14, 10);
        expect(matrix['CNH']['USD']).not.toBe(matrix['CNY']['USD']);
    });
});
