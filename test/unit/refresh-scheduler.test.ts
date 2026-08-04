// refresh-scheduler（Phase 2，offline）：RefreshScheduler 生命周期契约测试。
// 覆盖：稳定抖动（57 个真实源名相位唯一、跨实例确定、首个刷新摊开在整个窗口内）、
// 全局有界并发（57 源同相位触发时并发不超过上限、队列有界、最终全部完成）、
// 失败退避（recordFailure 后 tick 跳过、退避过期后重试、失败计数）、在途去重
// （上一轮刷新未完成时下一 tick 不重复启动）、stop() 幂等（取消定时器、关闭执行器）。
// 全程 jest 假时钟 + 注入假退避时钟，零公网访问，--detectOpenHandles 无泄漏。

import { jest } from '@jest/globals';
import {
    DEFAULT_REFRESH_INTERVAL_MS,
    RefreshScheduler,
} from '../../src/refreshScheduler';

// 与 src/index.ts 实际注册的 57 个抓取型源同名（wise 由 ENABLE_WISE 控制，计入 57）。
const REAL_SOURCES = [
    'boc',
    'bochk',
    'icbc',
    'cib',
    'cibHuanyu',
    'ccb',
    'abc',
    'bocom',
    'psbc',
    'cmb',
    'pboc',
    'unionpay',
    'jcb',
    'hsbc.hk',
    'hsbc.cn',
    'hsbc.au',
    'citic.cn',
    'ncb.cn',
    'ncb.hk',
    'spdb',
    'xib',
    'pab',
    'ceb',
    'cmbc',
    'cgb',
    'hxb',
    'cbhb',
    'bob',
    'bosc',
    'njcb',
    'hzbank',
    'gzcb',
    'hsbank',
    'bcq',
    'bcs',
    'cqtg',
    'ghb',
    'hfbank',
    'zybank',
    'bojs',
    'ecb',
    'cfets',
    'dbs',
    'dbs.cn',
    'dbs.hk',
    'alipay',
    'hkma',
    'hkab',
    'cncbi',
    'ccba',
    'cmbwl',
    'hsb',
    'icbca',
    'ocbchk',
    'ocbc',
    'bea',
    'wise',
];

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

/** 可控假时钟：手动推进，用于退避判定的确定性断言。 */
function fakeClock(startMs = 0) {
    let current = startMs;
    return {
        clock: { now: () => current },
        advance: (ms: number) => {
            current += ms;
        },
    };
}

afterEach(() => {
    jest.useRealTimers();
});

describe('RefreshScheduler stable jitter', () => {
    test('57 real source names get unique phases, stable across instances and within window', () => {
        const a = new RefreshScheduler({
            refreshFn: async (_source: string) => undefined,
            intervalMs: 30 * 60 * 1000,
            jitterWindowMs: 30 * 60 * 1000,
        });
        const b = new RefreshScheduler({
            refreshFn: async (_source: string) => undefined,
            intervalMs: 30 * 60 * 1000,
            jitterWindowMs: 30 * 60 * 1000,
        });
        const phases = REAL_SOURCES.map((s) => a.phaseOf(s));
        for (const phase of phases) {
            expect(phase).toBeGreaterThanOrEqual(0);
            expect(phase).toBeLessThan(30 * 60 * 1000);
        }
        // 跨实例确定：同一 source 相位一致（跨重启稳定，不会每次随机偏移）。
        REAL_SOURCES.forEach((s, i) => {
            expect(b.phaseOf(s)).toBe(phases[i]);
        });
        // 摊开：57 个源无一共享相位（真实名测得的 FNV-1a 分布）。
        expect(new Set(phases).size).toBe(REAL_SOURCES.length);
        a.stop();
        b.stop();
    });

    test('every source first refresh fires within the jitter window (no herd at t=0)', async () => {
        jest.useFakeTimers();
        const refreshFn = jest.fn(async (_source: string) => undefined);
        const sched = new RefreshScheduler({
            refreshFn,
            intervalMs: 30 * 60 * 1000,
            jitterWindowMs: 30 * 60 * 1000,
        });
        for (const s of REAL_SOURCES) sched.register(s);
        expect(sched.timerCount).toBe(REAL_SOURCES.length);

        // 推进到窗口末（intervalMs - 1）：所有源的首个 tick 都应已触发、且各一次。
        await jest.advanceTimersByTimeAsync(30 * 60 * 1000 - 1);
        expect(refreshFn).toHaveBeenCalledTimes(REAL_SOURCES.length);
        const called = new Set(
            (refreshFn.mock.calls as string[][]).map((c) => c[0]),
        );
        expect(called.size).toBe(REAL_SOURCES.length);
        expect(sched.refreshCount).toBe(REAL_SOURCES.length);
        sched.stop();
    });

    test('register is idempotent per source', async () => {
        jest.useFakeTimers();
        const refreshFn = jest.fn(async (_source: string) => undefined);
        const sched = new RefreshScheduler({
            refreshFn,
            intervalMs: 1000,
            jitterWindowMs: 0,
        });
        sched.register('a');
        sched.register('a');
        expect(sched.timerCount).toBe(1);
        sched.stop();
    });
});

describe('RefreshScheduler bounded global concurrency', () => {
    test('57 sources firing at the same phase keep active at the limit and all complete', async () => {
        jest.useFakeTimers();
        const gates: Deferred<void>[] = [];
        let active = 0;
        let activePeak = 0;
        const refreshFn = jest.fn(async () => {
            const gate = deferred<void>();
            gates.push(gate);
            active++;
            activePeak = Math.max(activePeak, active);
            await gate.promise;
            active--;
        });
        const sched = new RefreshScheduler({
            refreshFn,
            intervalMs: 60_000,
            jitterWindowMs: 0,
            concurrency: 3,
            queueSize: 128,
        });
        for (const s of REAL_SOURCES) sched.register(s);

        // 同相位（window=0）→ 57 个 tick 同一时刻触发，全部进入执行器（3 在途 + 54 排队）。
        await jest.advanceTimersByTimeAsync(1);
        expect(sched.active).toBe(3);
        expect(sched.queued).toBe(54);
        expect(activePeak).toBe(3);

        // 按批次放行：每批 3 个，19 批全部完成，全程并发不超过上限。
        for (let i = 0; i < 19; i++) {
            for (const gate of gates.splice(0, 3)) gate.resolve();
            await jest.advanceTimersByTimeAsync(1);
        }
        expect(activePeak).toBe(3);
        expect(sched.active).toBe(0);
        expect(sched.queued).toBe(0);
        expect(sched.refreshCount).toBe(REAL_SOURCES.length);
        expect(sched.successCount).toBe(REAL_SOURCES.length);
        expect(sched.failureCount).toBe(0);
        sched.stop();
    });
});

describe('RefreshScheduler backoff', () => {
    test('recordFailure blocks ticks; tick after expiry retries', async () => {
        jest.useFakeTimers();
        const fc = fakeClock(0);
        const refreshFn = jest.fn(async (_source: string) => undefined);
        const sched = new RefreshScheduler({
            refreshFn,
            intervalMs: 1000,
            jitterWindowMs: 0,
            backoffTtlMs: 500,
            backoffFactor: 2,
            backoffMaxDelayMs: 2000,
            clock: fc.clock,
        });
        sched.register('a');
        // 真实流程里 fxmManager.updateFXManager 负责 recordFailure；这里直接模拟。
        sched.recordFailure('a', new Error('boom'));
        expect(sched.blocked('a')).toBeDefined();

        // tick1 @0：退避期内 → 跳过，不启动刷新。
        await jest.advanceTimersByTimeAsync(1);
        expect(refreshFn).not.toHaveBeenCalled();
        expect(sched.skippedCount).toBe(1);
        expect(sched.refreshCount).toBe(0);

        // 退避仍有效（clock 未推进，expiry=500）：tick2 @1000 → 继续跳过。
        await jest.advanceTimersByTimeAsync(999);
        expect(refreshFn).not.toHaveBeenCalled();
        expect(sched.skippedCount).toBe(2);

        // 退避过期：tick3 @2000 → 重新启动刷新。
        fc.advance(501);
        await jest.advanceTimersByTimeAsync(1000);
        expect(refreshFn).toHaveBeenCalledTimes(1);
        expect(sched.refreshCount).toBe(1);
        sched.stop();
    });

    test('a throwing refresh counts as failure, not skipped', async () => {
        jest.useFakeTimers();
        const refreshFn = jest.fn(async () => {
            throw new Error('boom');
        });
        const sched = new RefreshScheduler({
            refreshFn,
            intervalMs: 1000,
            jitterWindowMs: 0,
        });
        sched.register('a');
        await jest.advanceTimersByTimeAsync(1);
        expect(refreshFn).toHaveBeenCalledTimes(1);
        expect(sched.failureCount).toBe(1);
        expect(sched.successCount).toBe(0);
        expect(sched.skippedCount).toBe(0);
        sched.stop();
    });

    test('executor closed/overload rejection is counted as skipped, not failure', async () => {
        jest.useFakeTimers();
        const gate = deferred<void>();
        const refreshFn = jest.fn(async () => {
            await gate.promise;
        });
        const sched = new RefreshScheduler({
            refreshFn,
            intervalMs: 1000,
            jitterWindowMs: 0,
            concurrency: 1,
            queueSize: 10,
        });
        for (const s of REAL_SOURCES.slice(0, 3)) sched.register(s);
        await jest.advanceTimersByTimeAsync(1);
        expect(sched.active).toBe(1);
        expect(sched.queued).toBe(2);

        // stop() 关闭执行器 → 排队任务以 closed 拒绝：不计入源失败。
        sched.stop();
        await jest.advanceTimersByTimeAsync(1);
        expect(sched.skippedCount).toBe(2);
        expect(sched.failureCount).toBe(0);

        gate.resolve();
        await jest.advanceTimersByTimeAsync(1);
        expect(sched.successCount).toBe(1);
    });
});

describe('RefreshScheduler in-flight dedup and stop', () => {
    test('a source still in flight is not re-refreshed on the next tick', async () => {
        jest.useFakeTimers();
        const gate = deferred<void>();
        let calls = 0;
        const refreshFn = jest.fn(async () => {
            calls++;
            await gate.promise;
        });
        const sched = new RefreshScheduler({
            refreshFn,
            intervalMs: 1000,
            jitterWindowMs: 0,
            concurrency: 4,
        });
        sched.register('a');
        await jest.advanceTimersByTimeAsync(1); // tick1：启动刷新（挂起）
        expect(calls).toBe(1);
        expect(sched.active).toBe(1);

        await jest.advanceTimersByTimeAsync(1000); // tick2：仍在途 → 跳过，不排队
        expect(calls).toBe(1);
        expect(sched.queued).toBe(0);
        expect(sched.skippedCount).toBe(1);

        gate.resolve();
        await jest.advanceTimersByTimeAsync(1); // 放行完成
        await jest.advanceTimersByTimeAsync(1000); // tick3：新周期重新启动
        expect(calls).toBe(2);
        sched.stop();
    });

    test('stop() cancels timers, closes executor, is idempotent, register is a no-op', async () => {
        jest.useFakeTimers();
        const refreshFn = jest.fn(async (_source: string) => undefined);
        const sched = new RefreshScheduler({
            refreshFn,
            intervalMs: 1000,
            jitterWindowMs: 0,
        });
        for (const s of REAL_SOURCES) sched.register(s);
        expect(sched.timerCount).toBe(REAL_SOURCES.length);

        sched.stop();
        expect(sched.isStopped).toBe(true);
        expect(sched.timerCount).toBe(0);

        await jest.advanceTimersByTimeAsync(100_000);
        expect(refreshFn).not.toHaveBeenCalled();

        sched.register('zzz');
        expect(sched.timerCount).toBe(0);
        sched.stop(); // 幂等
        expect(sched.isStopped).toBe(true);
    });

    test('invalid intervalMs throws TypeError', () => {
        expect(
            () =>
                new RefreshScheduler({
                    refreshFn: async () => undefined,
                    intervalMs: 0,
                }),
        ).toThrow(TypeError);
        expect(
            () =>
                new RefreshScheduler({
                    refreshFn: async () => undefined,
                    jitterWindowMs: -1,
                }),
        ).toThrow(TypeError);
    });
});

describe('RefreshScheduler parameter safe-int validation', () => {
    test('intervalMs that rounds to 0 is rejected (0.1/0.4)', () => {
        expect(
            () =>
                new RefreshScheduler({
                    refreshFn: async () => undefined,
                    intervalMs: 0.1,
                }),
        ).toThrow(TypeError);
        expect(
            () =>
                new RefreshScheduler({
                    refreshFn: async () => undefined,
                    intervalMs: 0.4,
                }),
        ).toThrow(TypeError);
    });

    test('intervalMs NaN / Infinity / above Node timer max are rejected', () => {
        expect(
            () =>
                new RefreshScheduler({
                    refreshFn: async () => undefined,
                    intervalMs: Number.NaN,
                }),
        ).toThrow(TypeError);
        expect(
            () =>
                new RefreshScheduler({
                    refreshFn: async () => undefined,
                    intervalMs: Number.POSITIVE_INFINITY,
                }),
        ).toThrow(TypeError);
        expect(
            () =>
                new RefreshScheduler({
                    refreshFn: async () => undefined,
                    intervalMs: 2_147_483_648,
                }),
        ).toThrow(TypeError);
    });

    test('jitterWindowMs NaN / above Node timer max are rejected', () => {
        expect(
            () =>
                new RefreshScheduler({
                    refreshFn: async () => undefined,
                    intervalMs: 1000,
                    jitterWindowMs: 2_147_483_648,
                }),
        ).toThrow(TypeError);
        expect(
            () =>
                new RefreshScheduler({
                    refreshFn: async () => undefined,
                    intervalMs: 1000,
                    jitterWindowMs: Number.NaN,
                }),
        ).toThrow(TypeError);
    });

    test('concurrency / queueSize / backoff params are bounded finite integers', () => {
        const bad = [
            { concurrency: 1.5 },
            { concurrency: 0 },
            { concurrency: 1025 },
            { queueSize: -1 },
            { queueSize: 1.5 },
            { backoffTtlMs: 0 },
            { backoffTtlMs: 2_147_483_648 },
            { backoffMaxDelayMs: -1 },
            { backoffMaxDelayMs: 2_147_483_648 },
            { backoffFactor: 0.5 },
            { backoffFactor: Number.NaN },
            { backoffMaxSize: -1 },
            { backoffMaxSize: 1.5 },
        ];
        for (const over of bad) {
            expect(
                () =>
                    new RefreshScheduler({
                        refreshFn: async () => undefined,
                        intervalMs: 1000,
                        ...over,
                    }),
            ).toThrow(TypeError);
        }
    });

    test('env FXRATE_REFRESH_INTERVAL_MS accepts integers only, falls back on 0.1/NaN/over-max', () => {
        const cases: [string, number][] = [
            ['0.1', DEFAULT_REFRESH_INTERVAL_MS],
            ['0.5', DEFAULT_REFRESH_INTERVAL_MS],
            ['NaN', DEFAULT_REFRESH_INTERVAL_MS],
            ['abc', DEFAULT_REFRESH_INTERVAL_MS],
            ['2147483648', DEFAULT_REFRESH_INTERVAL_MS],
            ['1500', 1500],
        ];
        for (const [raw, expected] of cases) {
            process.env.FXRATE_REFRESH_INTERVAL_MS = raw;
            const sched = new RefreshScheduler({
                refreshFn: async () => undefined,
            });
            expect(sched.interval).toBe(expected);
            sched.stop();
        }
        delete process.env.FXRATE_REFRESH_INTERVAL_MS;
    });
});

describe('RefreshScheduler drain contract', () => {
    test('drain resolves immediately when nothing is in flight', async () => {
        jest.useFakeTimers();
        const sched = new RefreshScheduler({
            refreshFn: async () => undefined,
            intervalMs: 1000,
            jitterWindowMs: 0,
        });
        await expect(sched.drain()).resolves.toBeUndefined();
        sched.stop();
    });

    test('drain waits for in-flight refreshes to settle after stop()', async () => {
        jest.useFakeTimers();
        const gate = deferred<void>();
        let released = false;
        const refreshFn = jest.fn(async () => {
            await gate.promise;
            released = true;
        });
        const sched = new RefreshScheduler({
            refreshFn,
            intervalMs: 1000,
            jitterWindowMs: 0,
            concurrency: 1,
        });
        sched.register('a');
        await jest.advanceTimersByTimeAsync(1); // tick 触发 → 刷新在途（挂在 gate 上）
        expect(sched.active).toBe(1);

        sched.stop(); // 停机：取消定时器 + 关闭执行器；在途任务继续运行
        let drained = false;
        const drainPromise = sched.drain().then(() => {
            drained = true;
        });
        // drain 必须等刷新 settle，不能立刻 resolve
        await Promise.resolve();
        await Promise.resolve();
        expect(drained).toBe(false);

        gate.resolve();
        await drainPromise;
        expect(drained).toBe(true);
        expect(released).toBe(true);
        expect(sched.active).toBe(0);
    });
});
