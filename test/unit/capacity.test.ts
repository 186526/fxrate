// capacity（Phase 1）：并发容量原语离线契约测试。
// 覆盖：keyed single-flight（500 同 key 只触发一次 factory、失败清理可重试、
// 单等待者取消不影响其他等待者、全取消后共享任务失败不产生 orphaned rejection）、
// 有界执行器（168 任务峰值、FIFO、队列溢出、排队取消、预中止、同步抛错、
// close 清理、计数、参数校验）、负缓存/指数退避（TTL 过期、退避增长、上限、
// 成功清除、命中/重试计数、maxSize 淘汰、参数校验）。
// 全程无真实定时器（退避用注入假时钟），可 --detectOpenHandles 验证无泄漏。

import {
    KeyedSingleFlight,
    BoundedExecutor,
    NegativeBackoffCache,
    CapacityError,
} from '../../src/capacity';

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

/** 可控假时钟：手动推进，用于负缓存退避的确定性断言。 */
function fakeClock(startMs = 0) {
    let current = startMs;
    return {
        clock: { now: () => current },
        advance: (ms: number) => {
            current += ms;
        },
    };
}

/** 等一个完整的事件循环轮次（宏任务），让所有已排队的微任务链跑完。 */
function tick(): Promise<void> {
    return new Promise((resolveTick) => setImmediate(resolveTick));
}

describe('KeyedSingleFlight', () => {
    test('500 same-key callers share a single factory invocation', async () => {
        const sf = new KeyedSingleFlight();
        const gate = deferred<number>();
        let calls = 0;
        const factory = () => {
            calls++;
            return gate.promise;
        };

        const promises: Promise<number>[] = [];
        for (let i = 0; i < 500; i++) {
            promises.push(sf.run('pair', factory));
        }
        expect(calls).toBe(1);
        expect(sf.size).toBe(1);

        gate.resolve(42);
        const results = await Promise.all(promises);
        expect(results).toEqual(Array(500).fill(42));
        expect(calls).toBe(1);
        expect(sf.size).toBe(0);
    });

    test('rejected task is removed from in-flight and can be retried', async () => {
        const sf = new KeyedSingleFlight();
        let calls = 0;
        const factory = () => {
            calls++;
            return Promise.reject(new Error('boom'));
        };

        const first = sf.run('pair', factory);
        expect(sf.size).toBe(1);
        await expect(first).rejects.toThrow('boom');
        expect(sf.size).toBe(0);

        const second = sf.run('pair', factory);
        expect(calls).toBe(2);
        await expect(second).rejects.toThrow('boom');
        expect(sf.size).toBe(0);
    });

    test('aborting one waiter does not abort the shared task for others', async () => {
        const sf = new KeyedSingleFlight();
        const gate = deferred<string>();
        let calls = 0;
        const factory = () => {
            calls++;
            return gate.promise;
        };

        const ac = new AbortController();
        const waiterA = sf.run('pair', factory, ac.signal);
        const waiterB = sf.run('pair', factory);
        expect(calls).toBe(1);

        ac.abort();
        await expect(waiterA).rejects.toMatchObject({ code: 'aborted' });

        gate.resolve('ok');
        await expect(waiterB).resolves.toBe('ok');
        expect(calls).toBe(1);
        expect(sf.size).toBe(0);
    });

    test('pre-aborted signal rejects without invoking factory', async () => {
        const sf = new KeyedSingleFlight();
        const ac = new AbortController();
        ac.abort();
        let calls = 0;
        const waiter = sf.run(
            'pair',
            () => {
                calls++;
                return Promise.resolve(1);
            },
            ac.signal,
        );
        await expect(waiter).rejects.toMatchObject({ code: 'aborted' });
        expect(calls).toBe(0);
        expect(sf.size).toBe(0);
    });

    test('shared task rejection with all waiters cancelled does not orphan', async () => {
        const sf = new KeyedSingleFlight();
        const gate = deferred<never>();
        const ac = new AbortController();
        const waiter = sf.run('pair', () => gate.promise, ac.signal);
        ac.abort();
        await expect(waiter).rejects.toMatchObject({ code: 'aborted' });

        // 后端对 unhandledRejection 致命退出——全等待者取消后共享任务失败必须被吞掉
        gate.reject(new Error('upstream down'));
        await tick();
        expect(sf.size).toBe(0);
    });

    test('synchronous factory throw is rejected and cleaned up', async () => {
        const sf = new KeyedSingleFlight();
        const waiter = sf.run('k', () => {
            throw new Error('sync');
        });
        await expect(waiter).rejects.toThrow('sync');
        expect(sf.size).toBe(0);
    });
});

describe('BoundedExecutor', () => {
    test('168 distinct tasks keep active at limit and all complete', async () => {
        const executor = new BoundedExecutor({ limit: 4, queueSize: 1000 });
        const gates = new Map<number, Deferred<number>>();
        let maxObservedActive = 0;

        const tasks: Promise<number>[] = [];
        for (let i = 0; i < 168; i++) {
            const gate = deferred<number>();
            gates.set(i, gate);
            tasks.push(
                executor.run(async () => {
                    maxObservedActive = Math.max(
                        maxObservedActive,
                        executor.active,
                    );
                    return gate.promise;
                }),
            );
        }
        expect(executor.active).toBe(4);
        expect(executor.queued).toBe(164);

        for (let i = 0; i < 168; i += 4) {
            for (let j = i; j < Math.min(i + 4, 168); j++) {
                gates.get(j)?.resolve(j);
            }
            await tick();
        }
        const results = await Promise.all(tasks);
        expect(results).toEqual(Array.from({ length: 168 }, (_, i) => i));
        expect(maxObservedActive).toBeLessThanOrEqual(4);
        expect(executor.active).toBe(0);
        expect(executor.queued).toBe(0);
    });

    test('tasks execute in FIFO order', async () => {
        const executor = new BoundedExecutor({ limit: 1, queueSize: 10 });
        const gates = new Map<number, Deferred<void>>();
        const order: number[] = [];
        const tasks: Promise<void>[] = [];
        for (let i = 0; i < 5; i++) {
            const gate = deferred<void>();
            gates.set(i, gate);
            tasks.push(
                executor.run(async () => {
                    order.push(i);
                    await gate.promise;
                }),
            );
        }
        expect(executor.active).toBe(1);
        expect(executor.queued).toBe(4);

        for (let i = 0; i < 5; i++) {
            gates.get(i)?.resolve();
            await tick();
        }
        await Promise.all(tasks);
        expect(order).toEqual([0, 1, 2, 3, 4]);
    });

    test('queue overflow rejects with stable overload error', async () => {
        const executor = new BoundedExecutor({ limit: 1, queueSize: 2 });
        const gate = deferred<void>();
        const running = executor.run(() => gate.promise);
        const queued: Promise<number>[] = [];
        for (let i = 0; i < 2; i++) {
            queued.push(executor.run(async () => i));
        }
        expect(executor.queued).toBe(2);

        const overflow = executor.run(() => Promise.resolve(99));
        expect(overflow).rejects.toMatchObject({ code: 'overload' });
        await expect(overflow).rejects.toBeInstanceOf(CapacityError);
        expect(executor.rejected).toBe(1);
        expect(executor.queued).toBe(2);

        gate.resolve();
        await expect(running).resolves.toBeUndefined();
        const results = await Promise.all(queued);
        expect(results).toEqual([0, 1]);
        expect(executor.queued).toBe(0);
        expect(executor.active).toBe(0);
    });

    test('aborting a queued task cancels only that waiter', async () => {
        const executor = new BoundedExecutor({ limit: 1, queueSize: 5 });
        const gate = deferred<void>();
        const running = executor.run(() => gate.promise);

        const ac = new AbortController();
        const victim = executor.run(async () => 'victim', ac.signal);
        const survivor = executor.run(async () => 'survivor');
        expect(executor.queued).toBe(2);

        ac.abort();
        await expect(victim).rejects.toMatchObject({ code: 'aborted' });
        expect(executor.queued).toBe(1);
        expect(executor.rejected).toBe(1);

        gate.resolve();
        await expect(running).resolves.toBeUndefined();
        await expect(survivor).resolves.toBe('survivor');
        expect(executor.queued).toBe(0);
        expect(executor.active).toBe(0);
    });

    test('pre-aborted signal rejects without running or queueing', async () => {
        const executor = new BoundedExecutor({ limit: 1, queueSize: 2 });
        const ac = new AbortController();
        ac.abort();
        let ran = false;
        const task = executor.run(() => {
            ran = true;
            return Promise.resolve(1);
        }, ac.signal);
        await expect(task).rejects.toMatchObject({ code: 'aborted' });
        expect(ran).toBe(false);
        expect(executor.active).toBe(0);
        expect(executor.queued).toBe(0);
        expect(executor.rejected).toBe(1);
    });

    test('synchronous task throw is converted to rejection and releases the slot', async () => {
        const executor = new BoundedExecutor({ limit: 1, queueSize: 2 });
        const boom = executor.run(() => {
            throw new Error('sync boom');
        });
        await expect(boom).rejects.toThrow('sync boom');
        expect(executor.active).toBe(0);

        const ok = executor.run(async () => 'ok');
        await expect(ok).resolves.toBe('ok');
    });

    test('close() rejects queued work and further runs; active finishes', async () => {
        const executor = new BoundedExecutor({ limit: 1, queueSize: 5 });
        const gate = deferred<number>();
        const running = executor.run(() => gate.promise);
        const queued1 = executor.run(async () => 1);
        const queued2 = executor.run(async () => 2);
        expect(executor.queued).toBe(2);

        executor.close();
        expect(executor.isClosed).toBe(true);
        await expect(queued1).rejects.toMatchObject({ code: 'closed' });
        await expect(queued2).rejects.toMatchObject({ code: 'closed' });
        expect(executor.queued).toBe(0);
        expect(executor.rejected).toBe(2);

        const after = executor.run(() => Promise.resolve(3));
        await expect(after).rejects.toMatchObject({ code: 'closed' });
        expect(executor.rejected).toBe(3);

        gate.resolve(7);
        await expect(running).resolves.toBe(7);
        expect(executor.active).toBe(0);
        expect(executor.queued).toBe(0);
    });

    test('close() is idempotent', async () => {
        const executor = new BoundedExecutor({ limit: 1, queueSize: 1 });
        const gate = deferred<void>();
        const running = executor.run(() => gate.promise);
        const queued = executor.run(async () => 1);
        executor.close();
        executor.close();
        await expect(queued).rejects.toMatchObject({ code: 'closed' });
        expect(executor.rejected).toBe(1);
        gate.resolve();
        await expect(running).resolves.toBeUndefined();
    });

    test('invalid options throw TypeError', () => {
        expect(() => new BoundedExecutor({ limit: 0, queueSize: 1 })).toThrow(
            TypeError,
        );
        expect(() => new BoundedExecutor({ limit: 1.5, queueSize: 1 })).toThrow(
            TypeError,
        );
        expect(() => new BoundedExecutor({ limit: 1, queueSize: -1 })).toThrow(
            TypeError,
        );
        expect(() => new BoundedExecutor({ limit: NaN, queueSize: 1 })).toThrow(
            TypeError,
        );
    });
});

describe('NegativeBackoffCache', () => {
    test('short TTL: failure blocks until expiry then lifts', () => {
        const fc = fakeClock(1_000_000);
        const cache = new NegativeBackoffCache({
            ttlMs: 1000,
            clock: fc.clock,
        });
        cache.recordFailure('USDCNY', new Error('401 not published yet'));
        const blocked = cache.blocked('USDCNY');
        expect(blocked).toBeDefined();
        expect(blocked?.attempts).toBe(1);
        expect(blocked?.expiresAt).toBe(1_001_000);
        expect(cache.hitCount).toBe(1);

        fc.advance(999);
        expect(cache.blocked('USDCNY')).toBeDefined();
        fc.advance(1);
        expect(cache.blocked('USDCNY')).toBeUndefined();
    });

    test('repeated failures grow the backoff window exponentially', () => {
        const fc = fakeClock(0);
        const cache = new NegativeBackoffCache({
            ttlMs: 1000,
            factor: 2,
            clock: fc.clock,
        });
        cache.recordFailure('k', new Error('e1'));
        const w1 = cache.blocked('k')!;
        expect(w1.attempts).toBe(1);
        expect(w1.expiresAt - w1.lastFailureAt).toBe(1000);

        cache.recordFailure('k', new Error('e2'));
        const w2 = cache.blocked('k')!;
        expect(w2.attempts).toBe(2);
        expect(w2.expiresAt - w2.lastFailureAt).toBe(2000);

        cache.recordFailure('k', new Error('e3'));
        const w3 = cache.blocked('k')!;
        expect(w3.attempts).toBe(3);
        expect(w3.expiresAt - w3.lastFailureAt).toBe(4000);
    });

    test('maxDelayMs caps the backoff window', () => {
        const fc = fakeClock(0);
        const cache = new NegativeBackoffCache({
            ttlMs: 100,
            factor: 10,
            maxDelayMs: 500,
            clock: fc.clock,
        });
        for (let i = 0; i < 10; i++) cache.recordFailure('k');
        const rec = cache.blocked('k');
        expect(rec).toBeDefined();
        expect(rec!.expiresAt - rec!.lastFailureAt).toBe(500);
        expect(rec!.attempts).toBe(10);
    });

    test('success clears the negative entry and resets attempts', () => {
        const fc = fakeClock(0);
        const cache = new NegativeBackoffCache({
            ttlMs: 1000,
            clock: fc.clock,
        });
        cache.recordFailure('k', new Error('boom'));
        expect(cache.blocked('k')).toBeDefined();

        expect(cache.recordSuccess('k')).toBe(true);
        expect(cache.blocked('k')).toBeUndefined();
        expect(cache.size).toBe(0);

        cache.recordFailure('k', new Error('again'));
        const rec = cache.blocked('k');
        expect(rec?.attempts).toBe(1);
        expect(rec?.expiresAt).toBe(1000);
    });

    test('recordSuccess on unknown key returns false', () => {
        const cache = new NegativeBackoffCache({ ttlMs: 1000 });
        expect(cache.recordSuccess('missing')).toBe(false);
    });

    test('hit and retry counters', () => {
        const fc = fakeClock(0);
        const cache = new NegativeBackoffCache({
            ttlMs: 1000,
            clock: fc.clock,
        });
        cache.recordFailure('a', new Error('e1'));
        cache.recordFailure('b', new Error('e2'));
        expect(cache.retryCount).toBe(2);

        expect(cache.blocked('a')).toBeDefined();
        expect(cache.blocked('a')).toBeDefined();
        expect(cache.blocked('missing')).toBeUndefined();
        expect(cache.hitCount).toBe(2);

        fc.advance(1001);
        expect(cache.blocked('a')).toBeUndefined();
        expect(cache.hitCount).toBe(2);
    });

    test('records are bounded by maxSize (oldest evicted)', () => {
        const cache = new NegativeBackoffCache({ ttlMs: 60_000, maxSize: 3 });
        cache.recordFailure('a');
        cache.recordFailure('b');
        cache.recordFailure('c');
        cache.recordFailure('d');
        expect(cache.size).toBe(3);
        expect(cache.blocked('a')).toBeUndefined();
        expect(cache.blocked('b')).toBeDefined();
        expect(cache.blocked('c')).toBeDefined();
        expect(cache.blocked('d')).toBeDefined();
    });

    test('clear() empties all records but keeps counters', () => {
        const fc = fakeClock(0);
        const cache = new NegativeBackoffCache({
            ttlMs: 1000,
            clock: fc.clock,
        });
        cache.recordFailure('a');
        cache.recordFailure('b');
        cache.clear();
        expect(cache.size).toBe(0);
        expect(cache.blocked('a')).toBeUndefined();
        expect(cache.retryCount).toBe(2);
    });

    test('invalid options throw TypeError', () => {
        expect(() => new NegativeBackoffCache({ ttlMs: 0 })).toThrow(TypeError);
        expect(() => new NegativeBackoffCache({ ttlMs: -5 })).toThrow(
            TypeError,
        );
        expect(
            () => new NegativeBackoffCache({ ttlMs: 100, factor: 0.5 }),
        ).toThrow(TypeError);
        expect(() => new NegativeBackoffCache({ ttlMs: NaN })).toThrow(
            TypeError,
        );
        expect(
            () => new NegativeBackoffCache({ ttlMs: 100, maxDelayMs: NaN }),
        ).toThrow(TypeError);
        expect(
            () => new NegativeBackoffCache({ ttlMs: 100, maxDelayMs: 0 }),
        ).toThrow(TypeError);
        expect(
            () => new NegativeBackoffCache({ ttlMs: 100, maxDelayMs: -50 }),
        ).toThrow(TypeError);
        expect(
            () => new NegativeBackoffCache({ ttlMs: 100, maxSize: -1 }),
        ).toThrow(TypeError);
        expect(
            () => new NegativeBackoffCache({ ttlMs: 100, maxSize: 1.5 }),
        ).toThrow(TypeError);
        expect(
            () => new NegativeBackoffCache({ ttlMs: 100, maxSize: NaN }),
        ).toThrow(TypeError);
    });

    test('maxSize 0 disables the cache: records evicted immediately', () => {
        const cache = new NegativeBackoffCache({ ttlMs: 1000, maxSize: 0 });
        cache.recordFailure('k', new Error('boom'));
        expect(cache.retryCount).toBe(1);
        expect(cache.size).toBe(0);
        expect(cache.blocked('k')).toBeUndefined();
    });

    test('maxDelayMs smaller than ttlMs is accepted and clamped to ttlMs', () => {
        const fc = fakeClock(0);
        const cache = new NegativeBackoffCache({
            ttlMs: 1000,
            maxDelayMs: 100,
            clock: fc.clock,
        });
        cache.recordFailure('k');
        const rec = cache.blocked('k')!;
        expect(rec.expiresAt - rec.lastFailureAt).toBe(1000);
    });
});
