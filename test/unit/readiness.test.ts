// readiness（Phase 6，offline）：fxmManager 就绪门禁集成测试。
// 覆盖：关键源齐备且无降级 → readiness.ready=true 且 /info 200 status=ok；
// 快照恢复出降级源 → ready=false 且 /info 503 status=degraded（degraded 列出源）；
// 关键源未注册（缺失）→ ready=false 且 /info 503（missing 列出源）；
// 非关键源缺失不阻断就绪（readiness 只检查关键源列表）；
// 成功刷新清除降级后恢复 ready。
// 全程回环 HTTP + 注入假快照数据，零公网访问，--detectOpenHandles 无泄漏。

import { jest } from '@jest/globals';
import { fraction } from 'mathjs';
import { rootRouter } from 'handlers.js';
import { mkdtempSync, rmSync } from 'node:fs';
import http, { type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fxmManager, {
    CRITICAL_SOURCES,
    useInternalRestAPI,
} from '../../src/fxmManager';
import fxManager, { type FXRateType } from '../../src/fxm/fxManager';
import { currency, type FXRate } from '../../src/types';
import type { SourceRates } from '../../src/persistence';

const cacheDirs: string[] = [];
const managers: fxmManager[] = [];
const servers: Server[] = [];

beforeEach(() => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'fxrate-readiness-'));
    cacheDirs.push(cacheDir);
    process.env.FXRATE_CACHE_DIR = cacheDir;
    process.env.LOG_LEVEL = 'error';
});

afterAll(() => {
    delete process.env.FXRATE_CACHE_DIR;
    delete process.env.LOG_LEVEL;
    for (const dir of cacheDirs) rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
    jest.restoreAllMocks();
    for (const server of servers) server.close();
    servers.length = 0;
    for (const manager of managers) manager.stopAllInterval();
    managers.length = 0;
});

const noopGetter = async (): Promise<FXRate[]> => [];

/** 构造所有关键源都注册（每个都是空 getter）的 sources 表。 */
const makeSources = (): { [source: string]: () => Promise<FXRate[]> } => {
    const sources: { [source: string]: () => Promise<FXRate[]> } = {};
    for (const source of CRITICAL_SOURCES) sources[source] = noopGetter;
    return sources;
};

const makeManager = (
    sources: { [source: string]: () => Promise<FXRate[]> } = makeSources(),
): fxmManager => {
    const manager = new fxmManager(sources, {
        scheduler: { intervalMs: 3_600_000 },
    });
    // Phase 7 readiness 语义：仅注册不算就绪，关键源须已加载有效数据。
    // 给每个注册源恢复一份「当前时间」的新鲜快照 → 全部 ready 且非 degraded。
    const fresh: { [source: string]: SourceRates } = {};
    for (const source of Object.keys(sources)) {
        fresh[source] = rateCell(new Date());
    }
    manager.restoreSnapshot(fresh, { staleRateAgeMs: 24 * 3_600_000 });
    managers.push(manager);
    return manager;
};

const makeRate = (over: Partial<FXRate> = {}): FXRate =>
    ({
        currency: { from: 'USD', to: 'CNY' },
        rate: { middle: 7 },
        unit: 1,
        updated: new Date(),
        ...over,
    }) as FXRate;

/** 最小快照单源数据：只带 middle + updated（latestUpdatedAt 只读 updated）。 */
const rateCell = (updated: Date): SourceRates =>
    ({ USD: { CNY: { middle: 7, updated } } }) as unknown as SourceRates;

/**
 * 忠实复刻 mastercard/visa 的「懒矩阵 + 预热缓存」模式的惰性 FXM：
 * 注册时无任何数据（inner 为空），首次 getfxRateList 成功后才写入 inner。
 * hasUsableData 只读 inner 大小（模拟 mastercard/visa 的模块级 LRU cache.size），
 * 绝不触碰 fxRateList Proxy。
 */
class LazyCardFXM extends fxManager {
    ableToGetAllFXRate = false;
    fail = false;

    private readonly inner = new Map<string, FXRateType>();

    public get fxRateList() {
        return new Proxy(
            {} as { [from: string]: { [to: string]: FXRateType } },
            {
                get: (_target, prop) => {
                    if (typeof prop !== 'string') return undefined;
                    return new Proxy({} as { [to: string]: FXRateType }, {
                        get: (_child, prop2) => {
                            if (typeof prop2 !== 'string') return undefined;
                            return (
                                this.inner.get(`${prop}${prop2}`) ?? {
                                    cash: undefined,
                                    remit: undefined,
                                    middle: undefined,
                                    updated: undefined,
                                }
                            );
                        },
                    });
                },
            },
        );
    }

    public hasUsableData(): boolean {
        return this.inner.size > 0;
    }

    public async getfxRateList(from: currency, to: currency) {
        const key = `${String(from)}${String(to)}`;
        if (this.inner.has(key)) {
            return this.fxRateList[from][to];
        }
        if (this.fail) {
            throw new Error('upstream 403');
        }
        this.inner.set(key, {
            cash: fraction(7),
            remit: fraction(8),
            middle: fraction(7.5),
            updated: new Date('2026-08-01T00:00:00Z'),
        });
        return this.fxRateList[from][to];
    }

    constructor() {
        super([]);
    }
}

/** 预加载数据（构造时已写入）的普通 fxManager 实例，用于 registerFXM 直接 ready 判定。 */
const preloadedRates = [
    {
        currency: { from: 'USD', to: 'CNY' },
        rate: {
            buy: { cash: 6.5, remit: 6.6 },
            sell: { cash: 7.0, remit: 7.1 },
            middle: 6.75,
        },
        unit: 1,
        updated: new Date('2026-08-01T00:00:00Z'),
    },
];

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

const httpGetInfo = (
    port: number,
): Promise<{
    status: number;
    headers: http.IncomingHttpHeaders;
    body: Record<string, unknown>;
}> =>
    new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: '127.0.0.1',
                port,
                path: '/info',
                method: 'GET',
                agent: false,
            },
            (res) => {
                let body = '';
                res.on('data', (chunk) => {
                    body += chunk;
                });
                res.on('end', () =>
                    resolve({
                        status: res.statusCode ?? 0,
                        headers: res.headers,
                        body: JSON.parse(body) as Record<string, unknown>,
                    }),
                );
            },
        );
        req.on('error', reject);
        req.setTimeout(5000, () => req.destroy(new Error('request timeout')));
        req.end();
    });

describe('fxmManager readiness report', () => {
    test('all critical sources registered and none degraded => ready', () => {
        const manager = makeManager();
        const report = manager.readiness();
        expect(report.ready).toBe(true);
        expect(report.degraded).toEqual([]);
        expect(report.missing).toEqual([]);
        expect(report.pending).toEqual([]);
        expect(report.criticalSources).toEqual([...CRITICAL_SOURCES]);
    });

    test('registered but pending (not yet loaded) critical sources are not ready', () => {
        const sources = makeSources();
        const manager = new fxmManager(sources, {
            scheduler: { intervalMs: 3_600_000 },
        });
        managers.push(manager);
        // 全部关键源仅注册、未完成首次刷新/快照恢复 → pending，不能算就绪
        const report = manager.readiness();
        expect(report.ready).toBe(false);
        expect(report.missing).toEqual([]);
        expect(report.degraded).toEqual([]);
        expect(report.pending).toEqual([...CRITICAL_SOURCES]);

        // 恢复一份新鲜快照后全部就绪
        const fresh: { [source: string]: SourceRates } = {};
        for (const source of CRITICAL_SOURCES) {
            fresh[source] = rateCell(new Date());
        }
        manager.restoreSnapshot(fresh, { staleRateAgeMs: 24 * 3_600_000 });
        const after = manager.readiness();
        expect(after.ready).toBe(true);
        expect(after.pending).toEqual([]);
    });

    test('a missing critical source flips readiness with missing listing it', () => {
        const sources = makeSources();
        delete sources['unionpay'];
        const manager = makeManager(sources);

        const report = manager.readiness();
        expect(report.ready).toBe(false);
        expect(report.missing).toEqual(['unionpay']);
        expect(report.degraded).toEqual([]);
    });

    test('readiness only inspects the given critical-source list', () => {
        // 只注册 boc：按默认列表必然缺失；但传入自定义列表 [boc] 则就绪——
        // 说明非关键源缺失（这里其余关键源都未注册）不影响自定义判定。
        const manager = makeManager({ boc: noopGetter });
        expect(manager.readiness().ready).toBe(false);
        expect(manager.readiness(['boc']).ready).toBe(true);
        expect(manager.readiness(['boc']).missing).toEqual([]);
    });

    test('restored stale data marks degraded and flips readiness', () => {
        const manager = makeManager();
        const now = Date.now();
        manager.restoreSnapshot(
            { boc: rateCell(new Date(now - 10 * 24 * 3_600_000)) },
            { staleRateAgeMs: 24 * 3_600_000 },
        );

        expect(manager.isDegraded('boc')).toBe(true);
        const report = manager.readiness();
        expect(report.ready).toBe(false);
        expect(report.degraded).toEqual(['boc']);
        expect(report.missing).toEqual([]);
    });

    test('successful refresh clears degraded and restores readiness', async () => {
        const getter = jest
            .fn<() => Promise<FXRate[]>>()
            .mockResolvedValue([makeRate()]);
        const sources = makeSources();
        sources['boc'] = getter;
        const manager = makeManager(sources);
        manager.restoreSnapshot(
            { boc: rateCell(new Date(Date.now() - 10 * 24 * 3_600_000)) },
            { staleRateAgeMs: 24 * 3_600_000 },
        );
        expect(manager.readiness().ready).toBe(false);

        await manager.updateFXManager('boc');
        expect(manager.isDegraded('boc')).toBe(false);
        expect(manager.readiness().ready).toBe(true);
    });
});

describe('fxmManager /info readiness probe', () => {
    test('fully ready => 200 with status ok and ready true', async () => {
        const manager = makeManager();
        const app = buildApp(manager);
        const port = await listenApp(app);

        const res = await httpGetInfo(port);
        expect(res.status).toBe(200);
        expect(res.body['status']).toBe('ok');
        expect(res.body['ready']).toBe(true);
        expect(res.body['degraded']).toEqual([]);
        expect(res.body['missing']).toEqual([]);
        expect(res.body['pending']).toEqual([]);
        // 就绪探针不缓存
        expect(res.headers['cache-control']).toBe('no-store');
    });

    test('restored degraded data => 503 with status degraded and degraded list', async () => {
        const manager = makeManager();
        const now = Date.now();
        manager.restoreSnapshot(
            { cmb: rateCell(new Date(now - 10 * 24 * 3_600_000)) },
            { staleRateAgeMs: 24 * 3_600_000 },
        );
        const app = buildApp(manager);
        const port = await listenApp(app);

        const res = await httpGetInfo(port);
        expect(res.status).toBe(503);
        expect(res.body['status']).toBe('degraded');
        expect(res.body['ready']).toBe(false);
        expect(res.body['degraded']).toEqual(['cmb']);
    });

    test('missing critical source => 503 with missing list', async () => {
        const sources = makeSources();
        delete sources['icbc'];
        const manager = makeManager(sources);
        const app = buildApp(manager);
        const port = await listenApp(app);

        const res = await httpGetInfo(port);
        expect(res.status).toBe(503);
        expect(res.body['status']).toBe('degraded');
        expect(res.body['ready']).toBe(false);
        expect(res.body['missing']).toEqual(['icbc']);
        // 正常字段（版本/来源）不受影响：instanceInfo 仍可解析 body。
        expect(typeof res.body['version']).toBe('string');
        expect(res.body['sources']).not.toContain('icbc');
    });
});

describe('lazy FXM readiness (hasUsableData contract)', () => {
    test('default CRITICAL_SOURCES excludes on-demand card sources', () => {
        expect(CRITICAL_SOURCES).not.toContain('mastercard');
        expect(CRITICAL_SOURCES).not.toContain('visa');
        // unionpay（银联）是抓取型源，仍在默认关键列表
        expect(CRITICAL_SOURCES).toContain('unionpay');
    });

    test('an empty lazy FXM as custom critical is pending (registered but no data)', () => {
        const manager = new fxmManager({});
        manager.registerFXM('lazycard', new LazyCardFXM());
        managers.push(manager);

        expect(manager.getStatus('lazycard')).toBe('pending');
        const report = manager.readiness(['lazycard']);
        expect(report.ready).toBe(false);
        expect(report.missing).toEqual([]);
        expect(report.degraded).toEqual([]);
        expect(report.pending).toEqual(['lazycard']);
    });

    test('first successful warm-up flips a lazy FXM to ready', async () => {
        const manager = new fxmManager({});
        manager.registerFXM('lazycard', new LazyCardFXM());
        managers.push(manager);
        expect(manager.readiness(['lazycard']).ready).toBe(false);

        await useInternalRestAPI('lazycard/USD/CNY', manager);

        expect(manager.getStatus('lazycard')).toBe('ready');
        const report = manager.readiness(['lazycard']);
        expect(report.ready).toBe(true);
        expect(report.pending).toEqual([]);
    });

    test('a failed warm-up keeps a lazy FXM pending', async () => {
        const manager = new fxmManager({});
        const card = new LazyCardFXM();
        card.fail = true;
        manager.registerFXM('lazycard', card);
        managers.push(manager);

        await useInternalRestAPI('lazycard/USD/CNY', manager);

        expect(manager.getStatus('lazycard')).toBe('pending');
        expect(manager.readiness(['lazycard']).pending).toEqual(['lazycard']);
    });

    test('a preloaded fxManager via registerFXM is immediately ready', () => {
        const manager = new fxmManager({});
        manager.registerFXM(
            'bank',
            new fxManager(preloadedRates as unknown as FXRate[]),
        );
        managers.push(manager);

        expect(manager.getStatus('bank')).toBe('ready');
        expect(manager.readiness(['bank']).ready).toBe(true);
    });

    test('a lazy FXM under a critical source name keeps /info 503 until warmed', async () => {
        const sources = makeSources();
        delete sources['unionpay'];
        const manager = new fxmManager(sources, {
            scheduler: { intervalMs: 3_600_000 },
        });
        managers.push(manager);
        manager.registerFXM('unionpay', new LazyCardFXM());
        // 其余关键源恢复新鲜快照 → ready；unionpay（lazy）无数据 → pending
        const fresh: { [source: string]: SourceRates } = {};
        for (const source of CRITICAL_SOURCES) {
            if (source === 'unionpay') continue;
            fresh[source] = rateCell(new Date());
        }
        manager.restoreSnapshot(fresh, { staleRateAgeMs: 24 * 3_600_000 });
        const app = buildApp(manager);
        const port = await listenApp(app);

        const res = await httpGetInfo(port);
        expect(res.status).toBe(503);
        expect(res.body['status']).toBe('degraded');
        expect(res.body['pending']).toEqual(['unionpay']);

        // 首次成功预热（缓存写入）后 /info 恢复 200 status=ok
        await useInternalRestAPI('unionpay/USD/CNY', manager);
        const res2 = await httpGetInfo(port);
        expect(res2.status).toBe(200);
        expect(res2.body['status']).toBe('ok');
        expect(res2.body['pending']).toEqual([]);
    });
});
