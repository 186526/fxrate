// persistence-writer（Phase 5 优化 #8）：节流异步快照写入器契约测试（完全离线）。
// 覆盖：节流 newest-wins（窗口内 100/1000 次 enqueue ≤1 次写、窗口结束写最后状态）、
// 在途写期间再入队恰一次补写（串行化、无陈旧定时器重复写）、写失败保留上一份有效
// 文件 + 记录错误 + writer 状态不被污染、enqueue 不触碰 fs/stringify/producer、
// flush 幂等（取消定时器、重 dump 最新状态、并发合并、在途 join、永不 reject）、
// VERCEL/path=null 整体 no-op、saveSnapshotAsync 唯一临时名 + 原子 rename +
// 失败清理临时文件、snapshotThrottleMs env 解析。
// 全程 fake timers + 临时目录 + 注入 save/setTimer/clearTimer，零公网访问。

import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
} from 'node:fs';
import { jest } from '@jest/globals';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    loadSnapshot,
    saveSnapshotAsync,
    snapshotCachePath,
    type SnapshotData,
    type SourceRates,
} from '../../src/persistence';
import {
    DEFAULT_SNAPSHOT_THROTTLE_MS,
    SnapshotWriter,
    snapshotThrottleMs,
} from '../../src/persistenceWriter';

let dir: string;
const cacheFile = (): string => join(dir, 'fxrate-cache.json');

const quoteCell = (
    updated = new Date('2026-08-04T00:00:00.000Z'),
): SourceRates[string][string] =>
    ({
        middle: 7,
        cash: 6.9,
        remit: 6.95,
        updated,
    }) as unknown as SourceRates[string][string];

const testSources: SnapshotData = {
    bank: {
        USD: {
            CNY: quoteCell(),
        },
    },
};

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fxrate-writer-'));
    process.env.FXRATE_CACHE_DIR = dir;
});

afterEach(() => {
    jest.useRealTimers();
    delete process.env.FXRATE_CACHE_DIR;
    delete process.env.FXRATE_SNAPSHOT_THROTTLE_MS;
    delete process.env.VERCEL;
    rmSync(dir, { recursive: true, force: true });
});

function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
} {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

// fake timers 下可用的确定性 defer：真实 Promise 微任务（fake timers 不模拟
// Promise），await 时必然执行；替代生产默认的 setImmediate（会被 fake 化挂起）。
const microtaskDefer = (fn: () => void): void => {
    void Promise.resolve().then(fn);
};

describe('SnapshotWriter throttle semantics', () => {
    test('100 enqueues within one throttle window coalesce to a single newest-wins write', async () => {
        jest.useFakeTimers();
        let seq = 0;
        const writes: number[] = [];
        const save = jest.fn(async (sources: SnapshotData) => {
            writes.push((sources as unknown as { seq: number }).seq);
        });
        const writer = new SnapshotWriter({
            throttleMs: 1000,
            producer: () => ({ seq }) as unknown as SnapshotData,
            save,
            defer: microtaskDefer,
        });

        for (let i = 0; i < 100; i += 1) {
            seq = i;
            writer.enqueue();
        }
        expect(save).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(999);
        expect(save).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(1);
        expect(save).toHaveBeenCalledTimes(1);
        // newest-wins：窗口结束写出最后入队的状态
        expect(writes).toEqual([99]);

        // 窗口后无多余写
        await jest.advanceTimersByTimeAsync(5000);
        expect(save).toHaveBeenCalledTimes(1);
    });

    test('1000 enqueues in a 1s throttle window write once (plan budget: <=2)', async () => {
        jest.useFakeTimers();
        let seq = 0;
        const save = jest.fn(async () => {});
        const writer = new SnapshotWriter({
            throttleMs: 1000,
            producer: () => ({ seq: seq++ }) as unknown as SnapshotData,
            save,
            defer: microtaskDefer,
        });

        for (let i = 0; i < 1000; i += 1) writer.enqueue();
        await jest.advanceTimersByTimeAsync(1000);
        expect(save).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(10_000);
        expect(save.mock.calls.length).toBeLessThanOrEqual(2);
    });

    test('enqueue during an in-flight write triggers exactly one serialized follow-up write', async () => {
        jest.useFakeTimers();
        let seq = 0;
        const writes: number[] = [];
        const gate = deferred<void>();
        let saveCalls = 0;
        const save = jest.fn(async (sources: SnapshotData) => {
            saveCalls += 1;
            writes.push((sources as unknown as { seq: number }).seq);
            if (saveCalls === 1) await gate.promise;
        });
        const writer = new SnapshotWriter({
            throttleMs: 100,
            producer: () => ({ seq }) as unknown as SnapshotData,
            save,
            defer: microtaskDefer,
        });

        seq = 1;
        writer.enqueue();
        await jest.advanceTimersByTimeAsync(100);
        expect(saveCalls).toBe(1);
        expect(writes).toEqual([1]);

        // 在途写期间再入队两次 → 收敛为一次补写，且写最新状态
        seq = 2;
        writer.enqueue();
        seq = 3;
        writer.enqueue();
        gate.resolve();
        await jest.advanceTimersByTimeAsync(0);
        expect(saveCalls).toBe(2);
        expect(writes).toEqual([1, 3]);

        // 在途期间排的 trailing 定时器被消费，不产生第三次写
        await jest.advanceTimersByTimeAsync(10_000);
        expect(saveCalls).toBe(2);
    });

    test('enqueue performs no save, no producer read, and no stringify until the window ends', async () => {
        jest.useFakeTimers();
        const save = jest.fn(async () => {});
        const producer = jest.fn((): SnapshotData => ({}));
        const stringifySpy = jest.spyOn(JSON, 'stringify');
        const writer = new SnapshotWriter({
            throttleMs: 1000,
            producer,
            save,
            defer: microtaskDefer,
        });

        for (let i = 0; i < 1000; i += 1) writer.enqueue();
        expect(save).not.toHaveBeenCalled();
        expect(producer).not.toHaveBeenCalled();
        expect(stringifySpy).not.toHaveBeenCalled();

        await jest.advanceTimersByTimeAsync(1000);
        expect(save).toHaveBeenCalledTimes(1);
        expect(producer).toHaveBeenCalledTimes(1);
        stringifySpy.mockRestore();
    });

    test('enqueue burst performs zero disk activity until the throttle window elapses', async () => {
        jest.useFakeTimers();
        const writer = new SnapshotWriter({
            throttleMs: 1000,
            path: cacheFile(),
            producer: () => testSources,
            save: (sources) => saveSnapshotAsync(sources, cacheFile()),
            defer: microtaskDefer,
        });

        for (let i = 0; i < 1000; i += 1) writer.enqueue();
        expect(readdirSync(dir)).toEqual([]);

        await jest.advanceTimersByTimeAsync(999);
        expect(readdirSync(dir)).toEqual([]);

        await jest.advanceTimersByTimeAsync(1);
        // 定时器触发后 drain 是异步 fs I/O，flush 并入在途 drain 等待落盘完成
        await writer.flush();
        expect(existsSync(cacheFile())).toBe(true);
        // 原子写：同目录临时文件 + rename，最终目录只保留一个完整 snapshot
        expect(readdirSync(dir)).toEqual(['fxrate-cache.json']);
    });
});

describe('SnapshotWriter flush', () => {
    test('flush cancels the pending timer, re-dumps the latest state once, and leaves no timer', async () => {
        jest.useFakeTimers();
        let seq = 0;
        const writes: number[] = [];
        const save = jest.fn(async (sources: SnapshotData) => {
            writes.push((sources as unknown as { seq: number }).seq);
        });
        const writer = new SnapshotWriter({
            throttleMs: 1000,
            producer: () => ({ seq }) as unknown as SnapshotData,
            save,
            defer: microtaskDefer,
        });

        seq = 1;
        writer.enqueue();
        seq = 2;
        writer.enqueue();
        expect(jest.getTimerCount()).toBe(1);

        await writer.flush();
        expect(save).toHaveBeenCalledTimes(1);
        expect(writes).toEqual([2]);
        expect(jest.getTimerCount()).toBe(0);

        await jest.advanceTimersByTimeAsync(10_000);
        expect(save).toHaveBeenCalledTimes(1);
    });

    test('concurrent flush calls share a single drain', async () => {
        jest.useFakeTimers();
        const producer = jest.fn(() => ({}) as SnapshotData);
        const save = jest.fn(async () => {});
        const writer = new SnapshotWriter({
            throttleMs: 1000,
            producer,
            save,
            defer: microtaskDefer,
        });

        const firstFlush = writer.flush();
        expect(producer).not.toHaveBeenCalled();
        const results = await Promise.all([
            firstFlush,
            writer.flush(),
            writer.flush(),
        ]);
        expect(results).toEqual([undefined, undefined, undefined]);
        expect(save).toHaveBeenCalledTimes(1);

        await writer.flush();
        expect(save).toHaveBeenCalledTimes(1);
    });

    test('flush during an in-flight write joins the drain and settles after the follow-up', async () => {
        jest.useFakeTimers();
        const gate = deferred<void>();
        let saveCalls = 0;
        const save = jest.fn(async () => {
            saveCalls += 1;
            if (saveCalls === 1) await gate.promise;
        });
        const writer = new SnapshotWriter({
            throttleMs: 100,
            producer: () => ({}) as SnapshotData,
            save,
            defer: microtaskDefer,
        });

        writer.enqueue();
        await jest.advanceTimersByTimeAsync(100);
        expect(saveCalls).toBe(1);

        writer.enqueue();
        const flushPromise = writer.flush();
        gate.resolve();
        await flushPromise;
        expect(saveCalls).toBe(2);
    });

    test('flush never rejects even when the save function throws', async () => {
        jest.useFakeTimers();
        const errorSpy = jest
            .spyOn(console, 'error')
            .mockImplementation(() => {});
        const writer = new SnapshotWriter({
            throttleMs: 100,
            producer: () => ({}) as SnapshotData,
            save: async () => {
                throw new Error('disk full');
            },
            defer: microtaskDefer,
        });

        writer.enqueue();
        await expect(writer.flush()).resolves.toBeUndefined();
        expect(errorSpy).toHaveBeenCalled();
        errorSpy.mockRestore();
    });

    test('shutdown-style flush after enqueue writes once and leaves no timer or temp file', async () => {
        jest.useFakeTimers();
        const writer = new SnapshotWriter({
            throttleMs: 1000,
            path: cacheFile(),
            producer: () => testSources,
            save: (sources) => saveSnapshotAsync(sources, cacheFile()),
            defer: microtaskDefer,
        });

        writer.enqueue();
        await writer.flush();
        expect(existsSync(cacheFile())).toBe(true);
        expect(readdirSync(dir)).toEqual(['fxrate-cache.json']);
        expect(jest.getTimerCount()).toBe(0);

        await jest.advanceTimersByTimeAsync(5000);
        expect(readdirSync(dir)).toEqual(['fxrate-cache.json']);
    });

    test('flush only queues work: producer does not run until the deferred turn', async () => {
        jest.useFakeTimers();
        const deferredTurns: Array<() => void> = [];
        const defer = (fn: () => void): void => {
            deferredTurns.push(fn);
        };
        let producerCalls = 0;
        const writer = new SnapshotWriter({
            throttleMs: 1000,
            producer: () => {
                producerCalls += 1;
                return {} as SnapshotData;
            },
            save: async () => {},
            defer,
        });

        const flushPromise = writer.flush();
        // flush 只排队：producer 尚未执行，drain 等待 defer 轮次
        expect(producerCalls).toBe(0);
        expect(deferredTurns.length).toBe(1);

        deferredTurns[0]();
        await flushPromise;
        expect(producerCalls).toBe(1);
        expect(deferredTurns.length).toBe(1);
    });

    test('first idle flush writes once; sequential idle flush is a no-op', async () => {
        jest.useFakeTimers();
        const save = jest.fn(async () => {});
        const writer = new SnapshotWriter({
            throttleMs: 1000,
            producer: () => ({}) as SnapshotData,
            save,
            defer: microtaskDefer,
        });

        await writer.flush();
        expect(save).toHaveBeenCalledTimes(1);

        // 顺序空闲 flush：无入队、无待重试失败 → no-op（不重复写）
        await writer.flush();
        await writer.flush();
        expect(save).toHaveBeenCalledTimes(1);

        // 入队后再 flush 恢复写一次
        writer.enqueue();
        await writer.flush();
        expect(save).toHaveBeenCalledTimes(2);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('failed flush leaves pending dirty state and the next flush retries', async () => {
        jest.useFakeTimers();
        const errorSpy = jest
            .spyOn(console, 'error')
            .mockImplementation(() => {});
        let fail = true;
        const save = jest.fn(async () => {
            if (fail) throw new Error('disk full');
        });
        const writer = new SnapshotWriter({
            throttleMs: 100,
            producer: () => ({}) as SnapshotData,
            save,
            defer: microtaskDefer,
        });

        writer.enqueue();
        await writer.flush();
        expect(save).toHaveBeenCalledTimes(1);
        expect(writer.pending).toBe(true);

        // 失败不清除待写状态：下一次显式 flush 重试
        fail = false;
        await writer.flush();
        expect(save).toHaveBeenCalledTimes(2);
        expect(writer.pending).toBe(false);
        errorSpy.mockRestore();
    });
});

describe('SnapshotWriter failure handling', () => {
    test('write failure logs the error, keeps the writer usable, and does not mark state stale', async () => {
        jest.useFakeTimers();
        const errorSpy = jest
            .spyOn(console, 'error')
            .mockImplementation(() => {});
        let calls = 0;
        const save = jest.fn(async () => {
            calls += 1;
            if (calls === 1) throw new Error('disk full');
        });
        const writer = new SnapshotWriter({
            throttleMs: 100,
            producer: () => ({}) as SnapshotData,
            save,
            defer: microtaskDefer,
        });

        writer.enqueue();
        await jest.advanceTimersByTimeAsync(100);
        expect(save).toHaveBeenCalledTimes(1);
        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(writer.pending).toBe(true);

        // writer 状态未被污染：后续 flush 正常写最新状态
        await expect(writer.flush()).resolves.toBeUndefined();
        expect(save).toHaveBeenCalledTimes(2);
        expect(writer.pending).toBe(false);
        errorSpy.mockRestore();
    });

    test('write failure retains the previous valid snapshot file', async () => {
        const errorSpy = jest
            .spyOn(console, 'error')
            .mockImplementation(() => {});
        let state: SnapshotData = testSources;
        const save = jest.fn(async (sources: SnapshotData) => {
            if (save.mock.calls.length === 2) throw new Error('disk full');
            await saveSnapshotAsync(sources, cacheFile());
        });
        const writer = new SnapshotWriter({
            throttleMs: 10,
            path: cacheFile(),
            producer: () => state,
            save,
            defer: microtaskDefer,
        });

        await writer.flush();
        expect(existsSync(cacheFile())).toBe(true);
        const goodContent = readFileSync(cacheFile(), 'utf-8');

        // 顺序空闲 flush 是 no-op，须先 enqueue 标记脏再 flush 才会触发写。
        state = { other: { EUR: { USD: quoteCell() } } };
        writer.enqueue();
        await writer.flush();
        expect(errorSpy).toHaveBeenCalled();
        // 失败保留上一份有效文件，且无残留临时文件
        expect(readFileSync(cacheFile(), 'utf-8')).toBe(goodContent);
        expect(readdirSync(dir)).toEqual(['fxrate-cache.json']);
        errorSpy.mockRestore();
    });
});

describe('SnapshotWriter VERCEL / disabled', () => {
    test('path=null writer is disabled: enqueue and flush are no-ops', async () => {
        jest.useFakeTimers();
        const save = jest.fn(async () => {});
        const writer = new SnapshotWriter({
            path: null,
            producer: () => ({}) as SnapshotData,
            save,
            defer: microtaskDefer,
        });

        expect(writer.enabled).toBe(false);
        writer.enqueue();
        await writer.flush();
        expect(save).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);
    });

    test('VERCEL=1 disables snapshot cache path resolution', () => {
        expect(snapshotCachePath()).not.toBeNull();
        process.env.VERCEL = '1';
        expect(snapshotCachePath()).toBeNull();
    });

    test('saveSnapshotAsync is a no-op when persistence is disabled (VERCEL=1)', async () => {
        process.env.VERCEL = '1';
        await expect(saveSnapshotAsync(testSources)).resolves.toBeUndefined();
        expect(readdirSync(dir)).toEqual([]);
    });
});

describe('snapshotThrottleMs env parsing', () => {
    test('defaults to DEFAULT_SNAPSHOT_THROTTLE_MS when unset or invalid', () => {
        delete process.env.FXRATE_SNAPSHOT_THROTTLE_MS;
        expect(snapshotThrottleMs()).toBe(DEFAULT_SNAPSHOT_THROTTLE_MS);

        for (const raw of ['0', '-5', 'abc', '2.5', 'Infinity']) {
            process.env.FXRATE_SNAPSHOT_THROTTLE_MS = raw;
            expect(snapshotThrottleMs()).toBe(DEFAULT_SNAPSHOT_THROTTLE_MS);
        }
    });

    test('accepts a positive integer', () => {
        process.env.FXRATE_SNAPSHOT_THROTTLE_MS = '500';
        expect(snapshotThrottleMs()).toBe(500);
    });

    test('SnapshotWriter reads throttleMs from the env by default', async () => {
        jest.useFakeTimers();
        process.env.FXRATE_SNAPSHOT_THROTTLE_MS = '500';
        const save = jest.fn(async () => {});
        const writer = new SnapshotWriter({
            producer: () => ({}) as SnapshotData,
            save,
            defer: microtaskDefer,
        });

        writer.enqueue();
        expect(save).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(499);
        expect(save).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(1);
        expect(save).toHaveBeenCalledTimes(1);
    });
});

describe('saveSnapshotAsync (real fs)', () => {
    test('round trip: saveSnapshotAsync then loadSnapshot restores sources', async () => {
        await saveSnapshotAsync(testSources, cacheFile());
        expect(existsSync(cacheFile())).toBe(true);

        const loaded = loadSnapshot();
        expect(loaded).not.toBeNull();
        const cell = loaded!['bank']!['USD']!['CNY'];
        expect(cell.updated).toBeInstanceOf(Date);
        expect((cell.updated as Date).toISOString()).toBe(
            '2026-08-04T00:00:00.000Z',
        );
    });

    test('uses unique temp names and leaves no tmp files after repeated saves', async () => {
        await saveSnapshotAsync(testSources, cacheFile());
        await saveSnapshotAsync(testSources, cacheFile());
        await saveSnapshotAsync(testSources, cacheFile());
        expect(readdirSync(dir)).toEqual(['fxrate-cache.json']);
    });

    test('rename failure rejects, cleans up its temp file, and keeps the target untouched', async () => {
        mkdirSync(cacheFile()); // 目标已是目录 → rename 失败
        await expect(
            saveSnapshotAsync(testSources, cacheFile()),
        ).rejects.toThrow();
        expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
        expect(existsSync(cacheFile())).toBe(true);
    });
});
