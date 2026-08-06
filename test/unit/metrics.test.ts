// metrics（Phase 6，offline）：Prometheus exposition 与专用 readiness 路由集成测试。
// 覆盖：8 个固定 family、合法数值样本与安全标签转义；RPC 拒绝、getter 抓取、
// BoundedExecutor active/queue wait、Card 缓存、Chromium 生命周期的真实更新钩子；
// /readyz 健康 200 / 降级 503、字段与 no-store；/info 响应结构保持不变。

import { jest } from '@jest/globals';
import { rootRouter } from 'handlers.js';
import { LRUCache } from 'lru-cache';
import { mkdtempSync, rmSync } from 'node:fs';
import http, { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BoundedExecutor } from '../../src/capacity';
import {
    CardCoordinator,
    createCardNegativeCache,
} from '../../src/FXGetter/cardCapacity';
import {
    __setChromiumLauncherForTests,
    fetchTextViaChromium,
} from '../../src/FXGetter/chromiumFetcher';
import fxmManager, { CRITICAL_SOURCES } from '../../src/fxmManager';
import {
    getMetricsSnapshot,
    observeShutdown,
    observeSourceFetch,
    renderMetrics,
    resetMetricsForTests,
} from '../../src/metrics';
import type { SourceRates } from '../../src/persistence';
import type { FXRate } from '../../src/types';

interface HttpResponse {
    status: number;
    headers: http.IncomingHttpHeaders;
    body: string;
}

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
}

const METRIC_FAMILIES = [
    'fxrate_rpc_batch_items',
    'fxrate_rpc_rejected_total',
    'fxrate_work_active',
    'fxrate_work_queue_wait_seconds',
    'fxrate_source_fetch_seconds',
    'fxrate_chromium_active',
    'fxrate_cache_hits_total',
    'fxrate_shutdown_seconds',
] as const;

const NUMERIC_SAMPLE_NAMES: Record<(typeof METRIC_FAMILIES)[number], string> = {
    fxrate_rpc_batch_items: 'fxrate_rpc_batch_items_count',
    fxrate_rpc_rejected_total: 'fxrate_rpc_rejected_total',
    fxrate_work_active: 'fxrate_work_active',
    fxrate_work_queue_wait_seconds: 'fxrate_work_queue_wait_seconds_count',
    fxrate_source_fetch_seconds: 'fxrate_source_fetch_seconds_count',
    fxrate_chromium_active: 'fxrate_chromium_active',
    fxrate_cache_hits_total: 'fxrate_cache_hits_total',
    fxrate_shutdown_seconds: 'fxrate_shutdown_seconds_count',
};

const managers: fxmManager[] = [];
const servers: Server[] = [];
let cacheDir: string;

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

const makeRate = (): FXRate =>
    ({
        currency: { from: 'USD', to: 'CNY' },
        rate: { middle: 7 },
        unit: 1,
        updated: new Date(),
    }) as FXRate;

const rateCell = (updated: Date): SourceRates =>
    ({ USD: { CNY: { middle: 7, updated } } }) as unknown as SourceRates;

const makeSources = (): { [source: string]: () => Promise<FXRate[]> } => {
    const sources: { [source: string]: () => Promise<FXRate[]> } = {};
    for (const source of CRITICAL_SOURCES) {
        sources[source] = async () => [makeRate()];
    }
    return sources;
};

const makeHealthyManager = (): fxmManager => {
    const manager = new fxmManager(makeSources(), {
        scheduler: { intervalMs: 3_600_000 },
    });
    const fresh: { [source: string]: SourceRates } = {};
    for (const source of CRITICAL_SOURCES) fresh[source] = rateCell(new Date());
    manager.restoreSnapshot(fresh, { staleRateAgeMs: 24 * 3_600_000 });
    managers.push(manager);
    return manager;
};

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
    const address = server.address();
    if (address === null || typeof address === 'string') {
        throw new Error('unexpected server address');
    }
    return address.port;
};

const httpRequest = (
    port: number,
    options: { method: string; path: string; body?: string },
): Promise<HttpResponse> =>
    new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: '127.0.0.1',
                port,
                path: options.path,
                method: options.method,
                headers:
                    options.body === undefined
                        ? undefined
                        : { 'Content-Type': 'application/json' },
                agent: false,
            },
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
        req.end(options.body);
    });

const get = (port: number, path: string): Promise<HttpResponse> =>
    httpRequest(port, { method: 'GET', path });

const postJson = (
    port: number,
    path: string,
    body: unknown,
): Promise<HttpResponse> =>
    httpRequest(port, {
        method: 'POST',
        path,
        body: JSON.stringify(body),
    });

const closeServer = (server: Server): Promise<void> =>
    new Promise((resolve) => {
        if (!server.listening) {
            resolve();
            return;
        }
        server.close(() => resolve());
    });

const aggregateSample = (
    familyName: string,
    sampleName: string,
): number | undefined => {
    const family = getMetricsSnapshot().find(
        (candidate) => candidate.name === familyName,
    );
    return family?.samples.find(
        (sample) =>
            sample.name === sampleName &&
            Object.values(sample.labels).every((value) => value === 'all'),
    )?.value;
};

const chromiumActiveValue = (): number | undefined => {
    const family = getMetricsSnapshot().find(
        (candidate) => candidate.name === 'fxrate_chromium_active',
    );
    return family?.samples.find(
        (sample) => sample.name === 'fxrate_chromium_active',
    )?.value;
};

beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'fxrate-metrics-'));
    process.env.FXRATE_CACHE_DIR = cacheDir;
    process.env.LOG_LEVEL = 'error';
    resetMetricsForTests();
});

afterEach(async () => {
    __setChromiumLauncherForTests(null);
    jest.restoreAllMocks();
    await Promise.all(servers.splice(0).map((server) => closeServer(server)));
    await Promise.all(
        managers.splice(0).map((manager) => manager.stopAllInterval()),
    );
    rmSync(cacheDir, { recursive: true, force: true });
});

afterAll(() => {
    delete process.env.FXRATE_CACHE_DIR;
    delete process.env.LOG_LEVEL;
});

describe('GET /metrics', () => {
    test('exposes all families with valid numeric samples and runtime values', async () => {
        const manager = makeHealthyManager();
        const app = buildApp(manager);
        const port = await listenApp(app);

        const rejected = await postJson(
            port,
            '/v1/jsonrpc',
            Array.from({ length: 151 }, (_, index) => ({
                jsonrpc: '2.0',
                id: index,
                method: 'instanceInfo',
            })),
        );
        expect(rejected.status).toBe(200);
        await manager.updateFXManager('boc');

        const positive = new LRUCache<string, string>({ max: 5 });
        positive.set('USDCNY', 'cached');
        const coordinator = new CardCoordinator<string>({
            source: 'metrics_card',
            positive,
            negative: createCardNegativeCache(),
            normalize: (code) => code,
            nativeWorkflow: async () => 'fresh',
            validate: () => undefined,
            serialize: (value) => value,
        });
        await coordinator.get('USD', 'CNY');
        observeShutdown('graceful', 0.25);

        const workGate = deferred<void>();
        const executor = new BoundedExecutor({
            limit: 1,
            queueSize: 1,
            metricsLabel: 'metrics_test',
        });
        const running = executor.run(() => workGate.promise);
        const queued = executor.run(async () => undefined);

        const chromiumGate = deferred<void>();
        const chromiumEntered = deferred<void>();
        __setChromiumLauncherForTests({
            launch: async () => ({
                newContext: async () => ({
                    newPage: async () => ({
                        goto: async () => {
                            chromiumEntered.resolve();
                            await chromiumGate.promise;
                            return { status: () => 200 };
                        },
                        evaluate: async () => 'ok',
                    }),
                }),
                close: async () => undefined,
            }),
        });
        const chromiumFetch = fetchTextViaChromium(['https://example.test']);
        await chromiumEntered.promise;

        try {
            const active = await get(port, '/metrics');
            expect(active.body).toMatch(
                /^fxrate_work_active\{kind="metrics_test"\} 1$/m,
            );
            expect(active.body).toMatch(/^fxrate_chromium_active 1$/m);
        } finally {
            workGate.resolve();
            chromiumGate.resolve();
            await Promise.all([running, queued, chromiumFetch]);
        }

        const response = await get(port, '/metrics');
        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toBe(
            'text/plain; version=0.0.4; charset=utf-8',
        );
        expect(response.headers['cache-control']).toBe('no-store');

        const sampleLines = response.body
            .split('\n')
            .filter((line) => line.length > 0 && !line.startsWith('#'));
        expect(sampleLines.length).toBeGreaterThan(METRIC_FAMILIES.length);
        for (const line of sampleLines) {
            expect(line).toMatch(
                /^[a-zA-Z_:][a-zA-Z0-9_:]*(?:\{.*\})? -?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i,
            );
        }
        for (const family of METRIC_FAMILIES) {
            expect(response.body).toContain(`# HELP ${family} `);
            expect(response.body).toContain(`# TYPE ${family} `);
            expect(
                sampleLines.some((line) =>
                    line.startsWith(NUMERIC_SAMPLE_NAMES[family]),
                ),
            ).toBe(true);
        }

        expect(
            aggregateSample(
                'fxrate_rpc_batch_items',
                'fxrate_rpc_batch_items_count',
            ),
        ).toBe(1);
        expect(
            aggregateSample(
                'fxrate_rpc_rejected_total',
                'fxrate_rpc_rejected_total',
            ),
        ).toBe(1);
        expect(
            aggregateSample(
                'fxrate_work_queue_wait_seconds',
                'fxrate_work_queue_wait_seconds_count',
            ),
        ).toBe(1);
        expect(
            aggregateSample(
                'fxrate_source_fetch_seconds',
                'fxrate_source_fetch_seconds_count',
            ),
        ).toBe(1);
        expect(
            aggregateSample(
                'fxrate_cache_hits_total',
                'fxrate_cache_hits_total',
            ),
        ).toBe(1);
        expect(
            aggregateSample(
                'fxrate_shutdown_seconds',
                'fxrate_shutdown_seconds_count',
            ),
        ).toBe(1);
        expect(
            aggregateSample('fxrate_work_active', 'fxrate_work_active'),
        ).toBe(0);
        expect(
            aggregateSample('fxrate_chromium_active', 'fxrate_chromium_active'),
        ).toBe(0);
    });

    test('escapes dynamic Prometheus label values without breaking lines', () => {
        const source = 'quoted"\\\nsource';
        observeSourceFetch(source, 0.125);

        const exposition = renderMetrics();
        const line = exposition
            .split('\n')
            .find(
                (candidate) =>
                    candidate.startsWith(
                        'fxrate_source_fetch_seconds_count{source=',
                    ) && candidate.includes('quoted'),
            );
        expect(line).toBeDefined();
        expect(line).toContain('\\n');
        expect(line).toContain('\\' + '"');
        expect(line).toContain('\\\\');

        const sourceFamily = getMetricsSnapshot().find(
            (family) => family.name === 'fxrate_source_fetch_seconds',
        );
        expect(
            sourceFamily?.samples.some(
                (sample) => sample.labels['source'] === source,
            ),
        ).toBe(true);
    });
});

describe('Chromium active lifecycle', () => {
    test('close failure preserves a successful payload and leaves closure unconfirmed', async () => {
        const closeError = new Error('close failed');
        const errorLog = jest
            .spyOn(console, 'error')
            .mockImplementation(() => undefined);
        __setChromiumLauncherForTests({
            launch: async () => ({
                newContext: async () => ({
                    newPage: async () => ({
                        goto: async () => ({ status: () => 200 }),
                        evaluate: async () => 'successful payload',
                    }),
                }),
                close: async () => {
                    throw closeError;
                },
            }),
        });

        await expect(
            fetchTextViaChromium(['https://example.test']),
        ).resolves.toBe('successful payload');
        expect(errorLog).toHaveBeenCalledWith(
            '[chromium] browser close failed:',
            closeError,
        );
        expect(chromiumActiveValue()).toBe(1);
    });

    test('close failure preserves the primary fetch error', async () => {
        const primaryError = new Error('navigation failed');
        const closeError = new Error('close failed');
        const errorLog = jest
            .spyOn(console, 'error')
            .mockImplementation(() => undefined);
        __setChromiumLauncherForTests({
            launch: async () => ({
                newContext: async () => ({
                    newPage: async () => ({
                        goto: async () => {
                            throw primaryError;
                        },
                        evaluate: async () => 'unused',
                    }),
                }),
                close: async () => {
                    throw closeError;
                },
            }),
        });

        await expect(
            fetchTextViaChromium(['https://example.test']),
        ).rejects.toBe(primaryError);
        expect(errorLog).toHaveBeenCalledWith(
            '[chromium] browser close failed:',
            closeError,
        );
        expect(chromiumActiveValue()).toBe(1);
    });

    test('reported disconnection confirms closure even when close rejects', async () => {
        const closeError = new Error('close raced with disconnect');
        jest.spyOn(console, 'error').mockImplementation(() => undefined);
        __setChromiumLauncherForTests({
            launch: async () => ({
                newContext: async () => ({
                    newPage: async () => ({
                        goto: async () => ({ status: () => 200 }),
                        evaluate: async () => 'payload',
                    }),
                }),
                close: async () => {
                    throw closeError;
                },
                isConnected: () => false,
            }),
        });

        await expect(
            fetchTextViaChromium(['https://example.test']),
        ).resolves.toBe('payload');
        expect(chromiumActiveValue()).toBe(0);
    });
});

describe('GET /readyz', () => {
    test('healthy manager returns 200 with dedicated readiness fields', async () => {
        const manager = makeHealthyManager();
        const app = buildApp(manager);
        const port = await listenApp(app);

        const response = await get(port, '/readyz');
        expect(response.status).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        const body = JSON.parse(response.body) as Record<string, unknown>;
        expect(body['status']).toBe('ok');
        expect(body['ready']).toBe(true);
        expect(body['readySources']).toEqual([...CRITICAL_SOURCES]);
        expect(body['staleSources']).toEqual([]);
        expect(body['degraded']).toEqual([]);
        expect(body['missing']).toEqual([]);
        expect(body['pending']).toEqual([]);

        const info = await get(port, '/info');
        const infoBody = JSON.parse(info.body) as Record<string, unknown>;
        expect(infoBody).not.toHaveProperty('readySources');
        expect(infoBody).not.toHaveProperty('staleSources');
    });

    test('stale source returns 503 with degraded and stale listings', async () => {
        const manager = makeHealthyManager();
        manager.restoreSnapshot(
            {
                boc: rateCell(new Date(Date.now() - 10 * 24 * 3_600_000)),
            },
            { staleRateAgeMs: 24 * 3_600_000 },
        );
        const app = buildApp(manager);
        const port = await listenApp(app);

        const response = await get(port, '/readyz');
        expect(response.status).toBe(503);
        expect(response.headers['cache-control']).toBe('no-store');
        const body = JSON.parse(response.body) as Record<string, unknown>;
        expect(body['status']).toBe('degraded');
        expect(body['ready']).toBe(false);
        expect(body['staleSources']).toEqual(['boc']);
        expect(body['degraded']).toEqual(['boc']);
        expect(body['readySources']).not.toContain('boc');
        expect(body['missing']).toEqual([]);
        expect(body['pending']).toEqual([]);
    });
});
