// fxm-manager-refresh（Phase 2，offline）：fxmManager 生命周期集成测试。
// 覆盖：registerGetter 走 RefreshScheduler（相位定时器 + intervalIDs 句柄可观测）、
// stopAllInterval 停机契约（停调度器 + 落盘快照）、请求路径失败退避（退避期内
// requestFXManager 不再触发全量重抓）、已 ready 源刷新失败保持 ready 继续服务旧数据、
// 空 getter 结果视为刷新失败（不伪造新鲜度）、快照恢复按数据新鲜度标记 degraded、
// 降级源 Cache-Control 恒为 max-age=0 / 正常源为正数。
// 全程回环 HTTP + 注入假退避时钟，零公网访问，--detectOpenHandles 无泄漏。

import { jest } from '@jest/globals';
import { rootRouter } from 'handlers.js';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http, { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fxmManager from '../../src/fxmManager';
import fxManager from '../../src/fxm/fxManager';
import { FXRate } from '../../src/types';
import type { SnapshotData, SourceRates } from '../../src/persistence';

const cacheDirs: string[] = [];
const managers: fxmManager[] = [];
const servers: Server[] = [];

let cacheDir: string;

beforeEach(() => {
    delete process.env.FXRATE_DISABLE_REFRESH;
    cacheDir = mkdtempSync(join(tmpdir(), 'fxrate-fxm-refresh-'));
    cacheDirs.push(cacheDir);
    process.env.FXRATE_CACHE_DIR = cacheDir;
    process.env.LOG_LEVEL = 'error';
});

afterAll(() => {
    delete process.env.FXRATE_CACHE_DIR;
    delete process.env.LOG_LEVEL;
    for (const dir of cacheDirs) rmSync(dir, { recursive: true, force: true });
});

afterEach(async () => {
    delete process.env.FXRATE_DISABLE_REFRESH;
    jest.restoreAllMocks();
    for (const server of servers) server.close();
    servers.length = 0;
    // 停机落盘已异步化（throttled SnapshotWriter）：必须 await 所有 manager 的
    // stopAllInterval 完成 flush 后才允许 afterAll 删除临时目录，否则后台写与
    // rmSync 并发竞争（libuv 线程池在途 fs 操作 vs 同步删目录）会产生杂散 ENOENT。
    await Promise.allSettled(managers.map((m) => m.stopAllInterval()));
    managers.length = 0;
});

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

const makeRate = (over: Partial<FXRate> = {}): FXRate =>
    ({
        currency: { from: 'USD', to: 'CNY' },
        rate: { middle: 7 },
        unit: 1,
        updated: new Date(),
        ...over,
    }) as FXRate;

/** 跨汇率 fixture：USD→HKD 与 HKD→CNH 两条边（无 USD→CNY 直连），
 *  buy/sell 的 cash 与 remit 各异，供 BFS 三价断言区分 cash/remit/middle。 */
const makeCrossRates = (): FXRate[] =>
    [
        {
            currency: { from: 'USD', to: 'HKD' },
            rate: {
                buy: { cash: 7.8, remit: 7.85 },
                sell: { cash: 7.9, remit: 7.95 },
                middle: 7.85,
            },
            unit: 1,
            updated: new Date('2026-08-04T00:00:00Z'),
        },
        {
            currency: { from: 'HKD', to: 'CNH' },
            rate: {
                buy: { cash: 0.9, remit: 0.91 },
                sell: { cash: 0.93, remit: 0.94 },
                middle: 0.92,
            },
            unit: 1,
            updated: new Date('2026-08-04T01:00:00Z'),
        },
    ] as unknown as FXRate[];

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

/** 最小快照单源数据：只带 middle + updated（latestUpdatedAt 只读 updated）。 */
const rateCell = (updated: Date): SourceRates =>
    ({ USD: { CNY: { middle: 7, updated } } }) as unknown as SourceRates;

const buildApp = (manager: fxmManager): rootRouter => {
    const app = new rootRouter();
    app.use([manager], '/(.*)');
    app.use([manager], '/v1/(.*)');
    app.useMappingAdapter();
    servers.push((app.adapater as unknown as { server: Server }).server);
    return app;
};

const listenApp = async (app: rootRouter): Promise<number> => {
    await app.listen(0);
    const server = (app.adapater as unknown as { server: Server }).server;
    if (!server.listening) {
        await new Promise<void>((resolve, reject) => {
            server.once('listening', () => resolve());
            server.once('error', reject);
        });
    }
    const addr = server.address();
    if (addr === null || typeof addr === 'string') {
        throw new Error('unexpected server address');
    }
    return addr.port;
};

const httpGet = (
    port: number,
    path: string,
): Promise<{
    status: number;
    headers: http.IncomingHttpHeaders;
    body: string;
}> =>
    new Promise((resolve, reject) => {
        const req = http.request(
            { host: '127.0.0.1', port, path, method: 'GET', agent: false },
            (res) => {
                let body = '';
                res.setEncoding('utf-8');
                res.on('data', (chunk: string) => {
                    body += chunk;
                });
                res.on('end', () =>
                    resolve({
                        status: res.statusCode ?? 0,
                        headers: res.headers,
                        body,
                    }),
                );
            },
        );
        req.on('error', reject);
        req.setTimeout(5000, () => req.destroy(new Error('request timeout')));
        req.end();
    });

describe('fxmManager refresh scheduler wiring', () => {
    test('FXRATE_DISABLE_REFRESH skips periodic scheduling but keeps the source registered', () => {
        process.env.FXRATE_DISABLE_REFRESH = '1';
        const manager = new fxmManager(
            { fake: async () => [] },
            { scheduler: { intervalMs: 1, jitterWindowMs: 1 } },
        );
        managers.push(manager);

        expect(manager.has('fake')).toBe(true);
        expect(manager.getStatus('fake')).toBe('pending');
        expect(manager.refreshScheduler.timerCount).toBe(0);
    });

    test('registerGetter schedules a stable-phase timer and stopAllInterval clears it', () => {
        const manager = new fxmManager(
            { fake: async () => [] },
            { scheduler: { intervalMs: 3_600_000, jitterWindowMs: 3_600_000 } },
        );
        managers.push(manager);
        expect(manager.refreshScheduler.timerCount).toBe(1);
        const phase = manager.refreshScheduler.phaseOf('fake');
        expect(phase).toBeGreaterThanOrEqual(0);
        expect(phase).toBeLessThan(3_600_000);
        // onSchedule 钩子把当前定时器句柄同步进 intervalIDs（可观测）。
        expect(manager.intervalIDs['fake']?.timeout).toBeDefined();

        manager.stopAllInterval();
        expect(manager.refreshScheduler.isStopped).toBe(true);
        expect(manager.refreshScheduler.timerCount).toBe(0);
    });

    test('stopAllInterval persists a snapshot (shutdown contract)', async () => {
        const getter = jest
            .fn<() => Promise<FXRate[]>>()
            .mockResolvedValueOnce([makeRate()])
            .mockResolvedValue([]);
        const manager = new fxmManager(
            { fake: getter },
            { scheduler: { intervalMs: 3_600_000 } },
        );
        managers.push(manager);
        await manager.updateFXManager('fake');
        expect(manager.getStatus('fake')).toBe('ready');

        await manager.stopAllInterval();
        const file = join(cacheDir, 'fxrate-cache.json');
        expect(existsSync(file)).toBe(true);
        const parsed = JSON.parse(readFileSync(file, 'utf-8')) as {
            version: string;
            sources: SnapshotData;
        };
        expect(parsed.version).toBe('1');
        expect(parsed.sources['fake']).toBeDefined();
    });
});

describe('fxmManager refresh failure backoff', () => {
    test('failed lazy load backs off: requests do not re-fetch until expiry', async () => {
        const fc = fakeClock(0);
        const getter = jest.fn(async () => {
            throw new Error('upstream down');
        });
        const manager = new fxmManager(
            { fake: getter },
            {
                scheduler: {
                    intervalMs: 3_600_000,
                    backoffTtlMs: 60_000,
                    clock: fc.clock,
                },
            },
        );
        managers.push(manager);

        await expect(manager.updateFXManager('fake')).rejects.toThrow(
            'upstream down',
        );
        expect(getter).toHaveBeenCalledTimes(1);
        expect(manager.getStatus('fake')).toBe('pending');
        expect(manager.refreshScheduler.blocked('fake')).toBeDefined();

        // 退避期内：请求路径直接返回当前实例，不再触发全量重抓。
        await manager.requestFXManager('fake');
        expect(getter).toHaveBeenCalledTimes(1);

        // 退避过期：请求重新触发懒加载。
        fc.advance(60_001);
        await manager.requestFXManager('fake');
        expect(getter).toHaveBeenCalledTimes(2);
    });

    test('a ready source that fails to refresh stays ready and serves stale data', async () => {
        const getter = jest
            .fn<() => Promise<FXRate[]>>()
            .mockResolvedValueOnce([makeRate()])
            .mockRejectedValueOnce(new Error('boom'));
        const manager = new fxmManager(
            { fake: getter },
            { scheduler: { intervalMs: 3_600_000 } },
        );
        managers.push(manager);

        await manager.updateFXManager('fake');
        expect(manager.getStatus('fake')).toBe('ready');
        const refreshDateBefore = manager.intervalIDs['fake']!.refreshDate;

        await expect(manager.updateFXManager('fake')).rejects.toThrow('boom');
        expect(manager.getStatus('fake')).toBe('ready');
        expect(manager.refreshScheduler.blocked('fake')).toBeDefined();
        // 请求路径直接服务旧数据，不触发重抓；refreshDate 未变（没有伪造新鲜度）。
        await manager.requestFXManager('fake');
        expect(getter).toHaveBeenCalledTimes(2);
        expect(manager.intervalIDs['fake']!.refreshDate).toEqual(
            refreshDateBefore,
        );
    });

    test('a ready source that fails to refresh is marked degraded until the next success', async () => {
        const getter = jest
            .fn<() => Promise<FXRate[]>>()
            .mockResolvedValueOnce([makeRate()])
            .mockRejectedValueOnce(new Error('boom'))
            .mockResolvedValue([
                makeRate({ updated: new Date(Date.now() + 1000) }),
            ]);
        const manager = new fxmManager(
            { fake: getter },
            { scheduler: { intervalMs: 3_600_000 } },
        );
        managers.push(manager);

        await manager.updateFXManager('fake');
        expect(manager.isDegraded('fake')).toBe(false);
        expect(manager.readiness().degraded).toEqual([]);

        // 刷新失败 → 保持 ready 但标记 degraded（readiness 不再 ok，Cache-Control max-age=0）
        await expect(manager.updateFXManager('fake')).rejects.toThrow('boom');
        expect(manager.getStatus('fake')).toBe('ready');
        expect(manager.isDegraded('fake')).toBe(true);
        expect(manager.readiness().degraded).toEqual(['fake']);

        // 成功刷新 → unmarkDegraded，readiness 恢复
        await manager.updateFXManager('fake');
        expect(manager.isDegraded('fake')).toBe(false);
        expect(manager.readiness().degraded).toEqual([]);
    });

    test('failed refresh of a ready source degrades /info to 503 and Cache-Control to max-age=0, then recovers', async () => {
        const getter = jest
            .fn<() => Promise<FXRate[]>>()
            .mockResolvedValueOnce([makeRate()])
            .mockRejectedValueOnce(new Error('boom'))
            .mockResolvedValue([
                makeRate({ updated: new Date(Date.now() + 1000) }),
            ]);
        const manager = new fxmManager(
            { fake: getter },
            { scheduler: { intervalMs: 3_600_000 } },
        );
        managers.push(manager);
        await manager.updateFXManager('fake');

        await expect(manager.updateFXManager('fake')).rejects.toThrow('boom');

        const app = buildApp(manager);
        const port = await listenApp(app);

        // 失败后：该源 Cache-Control 恒为 max-age=0
        const pairRes = await httpGet(port, '/fake/USD/CNY/');
        expect(pairRes.status).toBe(200);
        expect(pairRes.headers['cache-control']).toBe('public, max-age=0');

        // /info 503 + degraded 列出该源 + no-store
        const infoRes = await httpGet(port, '/info');
        expect(infoRes.status).toBe(503);
        expect(infoRes.headers['cache-control']).toBe('no-store');
        const infoBody = JSON.parse(infoRes.body) as {
            status: string;
            degraded: string[];
        };
        expect(infoBody.status).toBe('degraded');
        expect(infoBody.degraded).toEqual(['fake']);

        // 成功刷新 → 该源解除降级（/info 恒为 503——本 manager 只注册了非关键源 fake，
        // 关键源缺失是另一条 readiness 维度；断言 degraded 列表不再含 fake）。
        await manager.updateFXManager('fake');
        const infoRes2 = await httpGet(port, '/info');
        expect(infoRes2.status).toBe(503);
        const infoBody2 = JSON.parse(infoRes2.body) as {
            degraded: string[];
        };
        expect(infoBody2.degraded).toEqual([]);
    });

    test('empty getter result is a failed refresh (no fake freshness)', async () => {
        const getter = jest.fn(async () => []);
        const manager = new fxmManager(
            { fake: getter },
            { scheduler: { intervalMs: 3_600_000 } },
        );
        managers.push(manager);
        const refreshDateBefore = manager.intervalIDs['fake']!.refreshDate;

        await expect(manager.updateFXManager('fake')).rejects.toThrow(
            'returned no rates',
        );
        expect(manager.getStatus('fake')).toBe('pending');
        expect(manager.refreshScheduler.blocked('fake')).toBeDefined();
        expect(manager.intervalIDs['fake']!.refreshDate).toEqual(
            refreshDateBefore,
        );
    });

    test('successful refresh clears the backoff record and marks data fresh', async () => {
        const getter = jest
            .fn<() => Promise<FXRate[]>>()
            .mockRejectedValueOnce(new Error('boom'))
            .mockResolvedValue([makeRate()]);
        const manager = new fxmManager(
            { fake: getter },
            { scheduler: { intervalMs: 3_600_000 } },
        );
        managers.push(manager);

        await expect(manager.updateFXManager('fake')).rejects.toThrow('boom');
        expect(manager.refreshScheduler.blocked('fake')).toBeDefined();

        await manager.updateFXManager('fake');
        expect(manager.refreshScheduler.blocked('fake')).toBeUndefined();
        expect(manager.getStatus('fake')).toBe('ready');
        expect(manager.isDegraded('fake')).toBe(false);
    });
});

describe('fxmManager snapshot restore degradation', () => {
    test('stale-rate sources are degraded, fresh ones are not', () => {
        const manager = new fxmManager(
            { stale: async () => [], fresh: async () => [] },
            { scheduler: { intervalMs: 3_600_000 } },
        );
        managers.push(manager);
        const now = Date.now();
        manager.restoreSnapshot(
            {
                stale: rateCell(new Date(now - 10 * 24 * 3_600_000)),
                fresh: rateCell(new Date(now - 60_000)),
            },
            { staleRateAgeMs: 24 * 3_600_000 },
        );

        expect(manager.getStatus('stale')).toBe('ready');
        expect(manager.getStatus('fresh')).toBe('ready');
        expect(manager.isDegraded('stale')).toBe(true);
        expect(manager.isDegraded('fresh')).toBe(false);
        expect(manager.getDegradedSources()).toEqual(['stale']);
        // 降级源 refreshDate 如实指向最后数据时间，不伪装新鲜。
        expect(manager.intervalIDs['stale']!.refreshDate.getTime()).toBe(
            now - 10 * 24 * 3_600_000,
        );
    });

    test('a source with no valid rates is degraded', () => {
        const manager = new fxmManager(
            { empty: async () => [] },
            { scheduler: { intervalMs: 3_600_000 } },
        );
        managers.push(manager);
        manager.restoreSnapshot(
            { empty: {} },
            { staleRateAgeMs: 24 * 3_600_000 },
        );
        expect(manager.isDegraded('empty')).toBe(true);
    });

    test('successful refresh clears a restored degraded source', async () => {
        const getter = jest
            .fn<() => Promise<FXRate[]>>()
            .mockResolvedValue([makeRate()]);
        const manager = new fxmManager(
            { fake: getter },
            { scheduler: { intervalMs: 3_600_000 } },
        );
        managers.push(manager);
        manager.restoreSnapshot(
            { fake: rateCell(new Date(Date.now() - 10 * 24 * 3_600_000)) },
            { staleRateAgeMs: 24 * 3_600_000 },
        );
        expect(manager.isDegraded('fake')).toBe(true);

        await manager.updateFXManager('fake');
        expect(manager.isDegraded('fake')).toBe(false);
        expect(manager.refreshScheduler.blocked('fake')).toBeUndefined();
    });
});

describe('fxmManager degraded Cache-Control (never fake freshness)', () => {
    test('degraded source emits max-age=0; fresh source emits a positive max-age', async () => {
        const manager = new fxmManager(
            { stale: async () => [], fresh: async () => [] },
            { scheduler: { intervalMs: 3_600_000 } },
        );
        managers.push(manager);
        const now = Date.now();
        manager.restoreSnapshot(
            {
                stale: rateCell(new Date(now - 3 * 24 * 3_600_000)),
                fresh: rateCell(new Date(now - 1000)),
            },
            { staleRateAgeMs: 24 * 3_600_000 },
        );

        const app = buildApp(manager);
        const port = await listenApp(app);

        const staleRes = await httpGet(port, '/stale/USD/CNY/');
        expect(staleRes.status).toBe(200);
        expect(staleRes.headers['cache-control']).toBe('public, max-age=0');

        const freshRes = await httpGet(port, '/fresh/USD/CNY/');
        expect(freshRes.status).toBe(200);
        const freshCc = freshRes.headers['cache-control'] ?? '';
        expect(freshCc).toMatch(/^public, max-age=\d+$/);
        const maxAge = Number(/\d+/.exec(freshCc)?.[0]);
        expect(maxAge).toBeGreaterThan(0);
    });
});

describe('fxmManager shutdown drain (no lost last refresh)', () => {
    test('stopAllInterval waits for in-flight refreshes before saving the snapshot', async () => {
        const gate = deferred<void>();
        const getter = jest.fn(async () => {
            await gate.promise;
            return [makeRate({ updated: new Date(Date.now() + 1000) })];
        });
        const manager = new fxmManager(
            { fake: getter },
            { scheduler: { intervalMs: 3_600_000 } },
        );
        managers.push(manager);

        // 手动触发刷新并停在 in-flight（getter 挂在 gate 上，不 settle）
        const inflight = manager.updateFXManager('fake');
        await Promise.resolve();
        await Promise.resolve();
        expect(manager.getStatus('fake')).toBe('pending');

        // 停机：stopAllInterval 必须等待在途刷新 settle 后才落盘快照
        const shutdownPromise = manager.stopAllInterval();
        let snapshotSaved = false;
        shutdownPromise.then(() => {
            snapshotSaved = true;
        });
        await Promise.resolve();
        await Promise.resolve();
        // 在途刷新未完成 → 快照尚未写入
        expect(snapshotSaved).toBe(false);

        // 放行 getter → 在途刷新完成写回数据 → 停机流程继续落盘
        gate.resolve();
        await inflight;
        await shutdownPromise;
        expect(snapshotSaved).toBe(true);
        expect(manager.getStatus('fake')).toBe('ready');

        const file = join(cacheDir, 'fxrate-cache.json');
        expect(existsSync(file)).toBe(true);
        const parsed = JSON.parse(readFileSync(file, 'utf-8')) as {
            sources: SnapshotData;
        };
        // 快照必须包含在途刷新刚写回的新数据（停机前最后一次刷新的数据不丢失）
        const cell = parsed.sources['fake']?.['USD']?.['CNY'] as unknown as {
            updated: string;
        };
        expect(cell).toBeDefined();
        expect(new Date(cell.updated).getTime()).toBeGreaterThan(
            Date.now() - 5000,
        );
    });

    test('stopAllInterval rejects refreshes started after shutdown begins', async () => {
        const getter = jest.fn(async () => [makeRate()]);
        const manager = new fxmManager(
            { fake: getter },
            { scheduler: { intervalMs: 3_600_000 } },
        );
        managers.push(manager);

        const shutdownPromise = manager.stopAllInterval();
        await expect(manager.updateFXManager('fake')).rejects.toThrow(
            'fxmManager is stopping',
        );
        await shutdownPromise;

        expect(getter).not.toHaveBeenCalled();
        expect(manager.getStatus('fake')).toBe('pending');
    });

    test('shutdown latch blocks lazy Card I/O even when the request already holds the FXM', async () => {
        const manager = new fxmManager(
            {},
            {
                scheduler: { intervalMs: 3_600_000 },
            },
        );
        managers.push(manager);
        const card = new fxManager([]);
        const getRate = jest.spyOn(card, 'getfxRateList');
        manager.registerFXM('card', card);

        const heldCard = await manager.requestFXManager('card');
        const shutdownPromise = manager.stopAllInterval();

        await expect(
            heldCard.getfxRateList('USD' as never, 'CNY' as never),
        ).rejects.toThrow('fxmManager is stopping');
        await expect(manager.requestFXManager('card')).rejects.toThrow(
            'fxmManager is stopping',
        );
        await shutdownPromise;
        expect(getRate).not.toHaveBeenCalled();
    });
});

describe('fxmManager BFS REST prices (no direct quote)', () => {
    test('BFS-reachable pair without a direct rate returns cash/remit/middle via REST', async () => {
        const manager = new fxmManager(
            { fake: async () => makeCrossRates() },
            { scheduler: { intervalMs: 3_600_000 } },
        );
        managers.push(manager);
        await manager.updateFXManager('fake');

        const app = buildApp(manager);
        const port = await listenApp(app);
        const res = await httpGet(port, '/fake/USD/CNY/?bfs=1');
        expect(res.status).toBe(200);
        const body = JSON.parse(res.body) as Record<string, unknown>;
        expect(body.path).toEqual(['USD', 'HKD', 'CNY']);
        expect(body.alias).toBe('CNH');
        // 三价：100 × 7.85 × 0.92 = 722.2（middle）；cash/remit 走各自路径值
        expect(body.middle).toBeCloseTo(722.2, 10);
        expect(body.cash).toBeCloseTo(702, 10);
        expect(body.remit).toBeCloseTo(714.35, 10);
    });
});
