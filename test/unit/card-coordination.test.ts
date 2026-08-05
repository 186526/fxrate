// card-coordination（Phase 1 Card 协调层，offline）：
// 覆盖 CardCoordinator 的取数顺序契约（正 LRU → 负缓存 blocked → keyed single-flight）、
// 成功路径（validate → 写正缓存 → recordSuccess）、最终失败（recordFailure → rethrow）、
// CapacityError（overload/closed/aborted）不污染负缓存、native/chromium 分池降级、
// 别名归一化共享 single-flight、负缓存 TTL 过期重试、共享 executor 上限（native 8 / chromium 1）。
// 全部使用注入的小容量 executor / 假时钟 / 假 workflow，零网络，可 --detectOpenHandles。

import { LRUCache } from 'lru-cache';

import { jest } from '@jest/globals';

import {
    BackoffClock,
    BoundedExecutor,
    NegativeBackoffCache,
} from '../../src/capacity';
import {
    CardCoordinator,
    CARD_CHROMIUM_EXECUTOR,
    CARD_NATIVE_EXECUTOR,
    CARD_NEGATIVE_TTL_MS,
} from '../../src/FXGetter/cardCapacity';
import { getMetricsSnapshot, resetMetricsForTests } from '../../src/metrics';

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function fakeClock(startMs = 0): {
    clock: BackoffClock;
    advance: (ms: number) => void;
} {
    let current = startMs;
    return {
        clock: { now: () => current },
        advance: (ms: number) => {
            current += ms;
        },
    };
}

type Payload = { value: string };

interface Harness {
    coordinator: CardCoordinator<Payload, string>;
    nativeWorkflow: ReturnType<typeof jest.fn>;
    chromiumWorkflow?: ReturnType<typeof jest.fn>;
    validate: ReturnType<typeof jest.fn>;
    serialize: ReturnType<typeof jest.fn>;
    validateStored?: (stored: string) => void;
    nativeExecutor: BoundedExecutor;
    chromiumExecutor?: BoundedExecutor;
    negative: NegativeBackoffCache;
}

function makeHarness(
    opts: {
        withChromium?: boolean;
        nativeLimit?: number;
        nativeQueue?: number;
        chromiumLimit?: number;
        chromiumQueue?: number;
        clock?: BackoffClock;
        validateStored?: (stored: string) => void;
    } = {},
): Harness {
    const nativeWorkflow = jest.fn(
        async (_from: string, _to: string): Promise<Payload> => ({
            value: 'native',
        }),
    );
    const chromiumWorkflow = jest.fn(
        async (_from: string, _to: string): Promise<Payload> => ({
            value: 'chromium',
        }),
    );
    const validate = jest.fn((_payload: Payload) => undefined);
    const serialize = jest.fn((payload: Payload) => JSON.stringify(payload));
    const nativeExecutor = new BoundedExecutor({
        limit: opts.nativeLimit ?? 8,
        queueSize: opts.nativeQueue ?? 64,
    });
    const chromiumExecutor = opts.withChromium
        ? new BoundedExecutor({
              limit: opts.chromiumLimit ?? 1,
              queueSize: opts.chromiumQueue ?? 8,
          })
        : undefined;
    const negative = new NegativeBackoffCache({
        ttlMs: CARD_NEGATIVE_TTL_MS,
        factor: 2,
        maxDelayMs: 60_000,
        maxSize: 500,
        clock: opts.clock,
    });
    const coordinator = new CardCoordinator<Payload, string>({
        source: 'card',
        positive: new LRUCache<string, string>({
            max: 500,
            ttl: 1000 * 60 * 30,
        }),
        negative,
        normalize: (code) => (code === 'CNH' ? 'CNY' : code),
        nativeWorkflow,
        chromiumWorkflow: opts.withChromium ? chromiumWorkflow : undefined,
        validate,
        serialize,
        validateStored: opts.validateStored,
        nativeExecutor,
        chromiumExecutor,
    });
    return {
        coordinator,
        nativeWorkflow,
        chromiumWorkflow,
        validate,
        serialize,
        validateStored: opts.validateStored,
        nativeExecutor,
        chromiumExecutor,
        negative,
    };
}

function sourceFetchCount(source = 'card'): number {
    const family = getMetricsSnapshot().find(
        (candidate) => candidate.name === 'fxrate_source_fetch_seconds',
    );
    return (
        family?.samples.find(
            (sample) =>
                sample.name === 'fxrate_source_fetch_seconds_count' &&
                sample.labels['source'] === source,
        )?.value ?? 0
    );
}

beforeEach(() => {
    resetMetricsForTests();
});

describe('CardCoordinator ordering (positive LRU -> negative blocked -> single-flight)', () => {
    test('positive cache hit short-circuits with zero upstream work', async () => {
        const h = makeHarness();
        h.coordinator.positive.set(
            'USDCNY',
            JSON.stringify({ value: 'cached' }),
        );
        await h.coordinator.get('USD', 'CNY');
        expect(h.nativeWorkflow).not.toHaveBeenCalled();
        expect(h.validate).not.toHaveBeenCalled();
    });

    test('negative blocked throws the stored error with zero upstream work', async () => {
        const h = makeHarness();
        const boom = new Error('upstream 403');
        h.negative.recordFailure('card:USD:CNY', boom);
        await expect(h.coordinator.get('USD', 'CNY')).rejects.toBe(boom);
        expect(h.nativeWorkflow).not.toHaveBeenCalled();
    });

    test('negative blocked hits are counted', async () => {
        const h = makeHarness();
        h.negative.recordFailure('card:USD:CNY', new Error('boom'));
        await expect(h.coordinator.get('USD', 'CNY')).rejects.toThrow('boom');
        await expect(h.coordinator.get('USD', 'CNY')).rejects.toThrow('boom');
        expect(h.negative.hitCount).toBe(2);
    });

    test('success path: validate -> positive cache -> negative recordSuccess', async () => {
        const fc = fakeClock(1_000_000);
        const h = makeHarness({ clock: fc.clock });
        h.negative.recordFailure('card:USD:CNY', new Error('stale'));
        expect(h.negative.size).toBe(1);
        // 记录过期后重试成功：recordSuccess 清除残留的负缓存条目。
        fc.advance(CARD_NEGATIVE_TTL_MS + 1);
        await h.coordinator.get('USD', 'CNY');
        expect(h.validate).toHaveBeenCalledTimes(1);
        expect(h.coordinator.positive.get('USDCNY')).toBe(
            JSON.stringify({ value: 'native' }),
        );
        expect(h.negative.size).toBe(0);
    });

    test('success path runs validateStored on the serialized value after serialize', async () => {
        const fc = fakeClock(1_000_000);
        const h = makeHarness({
            clock: fc.clock,
            validateStored: jest.fn(() => undefined),
        });
        await h.coordinator.get('USD', 'CNY');
        expect(h.serialize).toHaveBeenCalledTimes(1);
        expect(h.validateStored).toHaveBeenCalledTimes(1);
        expect(h.validateStored).toHaveBeenCalledWith(
            JSON.stringify({ value: 'native' }),
        );
        expect(h.coordinator.positive.get('USDCNY')).toBe(
            JSON.stringify({ value: 'native' }),
        );
        expect(h.negative.size).toBe(0);
    });

    test('validateStored failure records negative and never writes positive', async () => {
        const h = makeHarness({
            validateStored: jest.fn(() => {
                throw new Error('invalid stored rate');
            }),
        });
        await expect(h.coordinator.get('USD', 'CNY')).rejects.toThrow(
            'invalid stored rate',
        );
        expect(h.coordinator.positive.has('USDCNY')).toBe(false);
        expect(h.negative.blocked('card:USD:CNY')).toBeDefined();
        expect(
            (h.negative.blocked('card:USD:CNY')?.lastError as Error).message,
        ).toBe('invalid stored rate');
    });

    test('validateStored failure does not poison the negative cache across different keys', async () => {
        const h = makeHarness({
            validateStored: jest.fn((stored: string) => {
                if (stored.includes('bad')) {
                    throw new Error('invalid stored rate');
                }
            }),
        });
        h.nativeWorkflow.mockImplementationOnce(async () => ({ value: 'bad' }));
        await expect(h.coordinator.get('USD', 'CNY')).rejects.toThrow(
            'invalid stored rate',
        );
        await h.coordinator.get('EUR', 'CNY'); // 正常值不受影响
        expect(h.coordinator.positive.get('EURCNY')).toBe(
            JSON.stringify({ value: 'native' }),
        );
        expect(h.coordinator.positive.has('USDCNY')).toBe(false);
    });

    test('failed workflow records negative and rethrows the same error', async () => {
        const h = makeHarness();
        const boom = new Error('Visa API 403 for USD/CNY');
        h.nativeWorkflow.mockImplementation(async () => {
            throw boom;
        });
        await expect(h.coordinator.get('USD', 'CNY')).rejects.toBe(boom);
        expect(h.negative.blocked('card:USD:CNY')?.lastError).toBe(boom);
        expect(h.coordinator.positive.has('USDCNY')).toBe(false);
    });

    test('500 same-key callers trigger exactly one workflow', async () => {
        const h = makeHarness();
        const gate = deferred<Payload>();
        h.nativeWorkflow.mockImplementation(() => gate.promise);
        const calls: Promise<void>[] = [];
        for (let i = 0; i < 500; i++) {
            calls.push(h.coordinator.get('USD', 'CNY'));
        }
        expect(h.nativeWorkflow).toHaveBeenCalledTimes(1);
        expect(h.coordinator.inFlight).toBe(1);
        gate.resolve({ value: 'ok' });
        await Promise.all(calls);
        expect(h.nativeWorkflow).toHaveBeenCalledTimes(1);
        expect(h.coordinator.inFlight).toBe(0);
        expect(h.coordinator.positive.get('USDCNY')).toBe(
            JSON.stringify({ value: 'ok' }),
        );
    });

    test('CNH/CNY aliases share one normalized single-flight key', async () => {
        const h = makeHarness();
        const gate = deferred<Payload>();
        h.nativeWorkflow.mockImplementation(() => gate.promise);
        const a = h.coordinator.get('CNH', 'USD');
        const b = h.coordinator.get('CNY', 'USD');
        expect(h.nativeWorkflow).toHaveBeenCalledTimes(1);
        gate.resolve({ value: 'alias' });
        await Promise.all([a, b]);
        expect(h.nativeWorkflow).toHaveBeenCalledTimes(1);
        expect(h.coordinator.positive.get('CNYUSD')).toBe(
            JSON.stringify({ value: 'alias' }),
        );
    });

    test('aborting one waiter does not cancel the shared workflow nor poison negative', async () => {
        const h = makeHarness();
        const gate = deferred<Payload>();
        h.nativeWorkflow.mockImplementation(() => gate.promise);
        const ac = new AbortController();
        const waiterA = h.coordinator.get('USD', 'CNY', ac.signal);
        const waiterB = h.coordinator.get('USD', 'CNY');
        expect(h.nativeWorkflow).toHaveBeenCalledTimes(1);
        ac.abort();
        await expect(waiterA).rejects.toMatchObject({ code: 'aborted' });
        gate.resolve({ value: 'shared' });
        await waiterB;
        expect(h.nativeWorkflow).toHaveBeenCalledTimes(1);
        expect(h.negative.size).toBe(0);
    });
});

describe('CardCoordinator capacity errors do not poison negative cache', () => {
    test('native overload rejects with CapacityError and skips negative cache', async () => {
        const h = makeHarness({ nativeLimit: 1, nativeQueue: 1 });
        const blocker = deferred<void>();
        const occupying = h.nativeExecutor.run(() => blocker.promise);
        const waiting = h.coordinator.get('USD', 'CNY');
        const overflow = h.coordinator.get('EUR', 'CNY');
        // 第一条已占用唯一槽位，第二条排队，第三条 native 队列满 → overload。
        await expect(overflow).rejects.toMatchObject({ code: 'overload' });
        expect(h.nativeExecutor.queued).toBe(1);
        expect(sourceFetchCount()).toBe(0);
        expect(h.nativeWorkflow).not.toHaveBeenCalled();
        expect(h.negative.blocked('card:USD:CNY')).toBeUndefined();
        expect(h.negative.blocked('card:EUR:CNY')).toBeUndefined();
        blocker.resolve();
        await occupying;
        await waiting;
        expect(sourceFetchCount()).toBe(1);
    });

    test('closed executor rejects with CapacityError and skips negative cache', async () => {
        const h = makeHarness();
        h.nativeExecutor.close();
        await expect(h.coordinator.get('USD', 'CNY')).rejects.toMatchObject({
            code: 'closed',
        });
        expect(h.nativeWorkflow).not.toHaveBeenCalled();
        expect(h.negative.size).toBe(0);
        expect(sourceFetchCount()).toBe(0);
    });

    test('pre-aborted waiter rejects with aborted and starts no workflow', async () => {
        const h = makeHarness();
        const ac = new AbortController();
        ac.abort();
        await expect(
            h.coordinator.get('USD', 'CNY', ac.signal),
        ).rejects.toMatchObject({
            code: 'aborted',
        });
        expect(h.nativeWorkflow).not.toHaveBeenCalled();
        expect(h.negative.size).toBe(0);
        expect(sourceFetchCount()).toBe(0);
    });

    test('chromium overload skips negative cache too', async () => {
        const h = makeHarness({
            withChromium: true,
            chromiumLimit: 1,
            chromiumQueue: 1,
        });
        h.nativeWorkflow.mockImplementation(async () => {
            throw new Error('native 403');
        });
        const blocker = deferred<void>();
        const occupying = h.chromiumExecutor!.run(() => blocker.promise);
        const waiting = h.coordinator.get('USD', 'CNY');
        const overflow = h.coordinator.get('EUR', 'CNY');
        await expect(overflow).rejects.toMatchObject({ code: 'overload' });
        expect(h.negative.blocked('card:EUR:CNY')).toBeUndefined();
        blocker.resolve();
        await occupying;
        await waiting;
    });
});

describe('CardCoordinator chromium fallback (visa-style)', () => {
    test('non-capacity native failure falls back to chromium and succeeds', async () => {
        const h = makeHarness({ withChromium: true });
        h.nativeWorkflow.mockImplementation(async () => {
            throw new Error('Visa API 403 for USD/CNY');
        });
        await h.coordinator.get('USD', 'CNY');
        expect(h.chromiumWorkflow).toHaveBeenCalledTimes(1);
        expect(sourceFetchCount()).toBe(2);
        expect(h.coordinator.positive.get('USDCNY')).toBe(
            JSON.stringify({ value: 'chromium' }),
        );
        expect(h.negative.size).toBe(0);
    });

    test('both native and chromium failing yields combined error recorded in negative', async () => {
        const h = makeHarness({ withChromium: true });
        h.nativeWorkflow.mockImplementation(async () => {
            throw new Error('native boom');
        });
        h.chromiumWorkflow!.mockImplementation(async () => {
            throw new Error('chromium boom');
        });
        await expect(h.coordinator.get('USD', 'CNY')).rejects.toThrow(
            /native boom; chromium fallback failed: chromium boom/,
        );
        const record = h.negative.blocked('card:USD:CNY');
        expect(record).toBeDefined();
        expect((record?.lastError as Error).message).toContain('native boom');
    });

    test('native capacity error does NOT trigger chromium fallback', async () => {
        const h = makeHarness({
            withChromium: true,
            nativeLimit: 1,
            nativeQueue: 1,
        });
        const blocker = deferred<void>();
        const blocker2 = deferred<void>();
        const occupying = h.nativeExecutor.run(() => blocker.promise);
        const queued = h.nativeExecutor.run(() => blocker2.promise);
        const overflow = h.coordinator.get('USD', 'CNY');
        await expect(overflow).rejects.toMatchObject({ code: 'overload' });
        expect(h.chromiumWorkflow).not.toHaveBeenCalled();
        blocker.resolve();
        blocker2.resolve();
        await Promise.all([occupying, queued]);
    });
});

describe('CardCoordinator negative cache expiry and retry', () => {
    test('after TTL expiry a new workflow is allowed and success clears the entry', async () => {
        const fc = fakeClock(1_000_000);
        const h = makeHarness({ clock: fc.clock });
        h.nativeWorkflow.mockImplementationOnce(async () => {
            throw new Error('transient');
        });
        await expect(h.coordinator.get('USD', 'CNY')).rejects.toThrow(
            'transient',
        );
        expect(h.negative.blocked('card:USD:CNY')).toBeDefined();

        await expect(h.coordinator.get('USD', 'CNY')).rejects.toThrow(
            'transient',
        );
        expect(h.nativeWorkflow).toHaveBeenCalledTimes(1);

        fc.advance(CARD_NEGATIVE_TTL_MS + 1);
        await h.coordinator.get('USD', 'CNY');
        expect(h.nativeWorkflow).toHaveBeenCalledTimes(2);
        expect(h.negative.blocked('card:USD:CNY')).toBeUndefined();
        expect(h.coordinator.positive.get('USDCNY')).toBeDefined();
    });

    test('repeated failures grow the backoff window through the coordinator', async () => {
        const fc = fakeClock(0);
        const h = makeHarness({ clock: fc.clock });
        h.nativeWorkflow.mockImplementation(async () => {
            throw new Error('nope');
        });
        for (let i = 0; i < 3; i++) {
            await expect(h.coordinator.get('USD', 'CNY')).rejects.toThrow(
                'nope',
            );
            if (i < 2) fc.advance(CARD_NEGATIVE_TTL_MS * 2 ** i + 1);
        }
        expect(h.negative.blocked('card:USD:CNY')?.attempts).toBe(3);
        expect(h.negative.retryCount).toBe(3);
    });
});

describe('CardCoordinator shared executors', () => {
    test('native executor caps at 8 concurrent and queues the rest', async () => {
        const gates: Deferred<void>[] = [];
        const tasks: Promise<void>[] = [];
        for (let i = 0; i < 9; i++) {
            const gate = deferred<void>();
            gates.push(gate);
            tasks.push(CARD_NATIVE_EXECUTOR.run(() => gate.promise));
        }
        expect(CARD_NATIVE_EXECUTOR.active).toBe(8);
        expect(CARD_NATIVE_EXECUTOR.queued).toBe(1);
        for (const gate of gates) gate.resolve();
        await Promise.all(tasks);
        expect(CARD_NATIVE_EXECUTOR.active).toBe(0);
        expect(CARD_NATIVE_EXECUTOR.queued).toBe(0);
    });

    test('chromium executor caps at 1 concurrent and queues the rest', async () => {
        const gates: Deferred<void>[] = [];
        const tasks: Promise<void>[] = [];
        for (let i = 0; i < 2; i++) {
            const gate = deferred<void>();
            gates.push(gate);
            tasks.push(CARD_CHROMIUM_EXECUTOR.run(() => gate.promise));
        }
        expect(CARD_CHROMIUM_EXECUTOR.active).toBe(1);
        expect(CARD_CHROMIUM_EXECUTOR.queued).toBe(1);
        for (const gate of gates) gate.resolve();
        await Promise.all(tasks);
        expect(CARD_CHROMIUM_EXECUTOR.active).toBe(0);
        expect(CARD_CHROMIUM_EXECUTOR.queued).toBe(0);
    });

    test('mastercard and visa coordinators share the same native executor singleton', async () => {
        const { mastercardCoordinator } = await import(
            '../../src/FXGetter/mastercard'
        );
        const { visaCoordinator } = await import('../../src/FXGetter/visa');
        expect(mastercardCoordinator.nativeExecutor).toBe(CARD_NATIVE_EXECUTOR);
        expect(visaCoordinator.nativeExecutor).toBe(CARD_NATIVE_EXECUTOR);
        expect(visaCoordinator.chromiumExecutor).toBe(CARD_CHROMIUM_EXECUTOR);
    });
});
