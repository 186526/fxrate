// card-preheat（Phase 1 type=all 重复预热消除，offline）：
// 目标：一次 Card pair 业务请求对该 pair 至多预热一次（网络抓取一次），
// 随后 cash/remit/middle/updated 全部复用已预热的 Proxy 数据。
// 验证：
//  一、成功：type=all 请求恰好 1 次预热，cash/remit/middle/updated 齐全且正确；
//      同 pair 的第二次业务请求命中缓存，零新增预热。
//  二、失败：上游 403 时仍只预热 1 次（旧行为会为每个 type + post-response 共预热 5 次），
//      响应形状保持 {updated, cash:false, remit:false, middle:false}。
//  三、reverse：方向语义保留，正反两个方向 pair 各预热一次。
//  四、非 Card 行为不变：getter 源输出形状与数值不变；缺失 pair 全 false；Date 头与 body updated 一致。
// FakeCardFXM 忠实复刻 mastercard/visa 的「懒矩阵 + always-truthy Proxy + getfxRateList 预热缓存」模式，
// 网络尝试数 = inner 缓存 miss 次数。全部回环离线，不访问公网。

import { jest } from '@jest/globals';
import { fraction } from 'mathjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http, { type Server } from 'node:http';

import { rootRouter } from 'handlers.js';

import fxmManager, { useInternalRestAPI } from '../../src/fxmManager';
import fxManager, { type FXRateType } from '../../src/fxm/fxManager';
import { currency, type FXRate } from '../../src/types';

interface HttpResponse {
    status: number;
    body: string;
    headers: Record<string, string | string[] | undefined>;
}

const servers: Server[] = [];
const managers: fxmManager[] = [];

let cacheDir: string;

beforeAll(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'fxrate-card-preheat-'));
    process.env.FXRATE_CACHE_DIR = cacheDir;
    process.env.LOG_LEVEL = 'error';
});

afterAll(() => {
    delete process.env.FXRATE_CACHE_DIR;
    delete process.env.LOG_LEVEL;
    rmSync(cacheDir, { recursive: true, force: true });
});

afterEach(() => {
    jest.restoreAllMocks();
    for (const server of servers) server.close();
    servers.length = 0;
    for (const manager of managers) manager.stopAllInterval();
    managers.length = 0;
});

class FakeCardFXM extends fxManager {
    ableToGetAllFXRate = false;
    networkAttempts = 0;
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

    public async getfxRateList(from: currency, to: currency) {
        const key = `${String(from)}${String(to)}`;
        if (this.inner.has(key)) {
            return this.fxRateList[from][to];
        }
        this.networkAttempts++;
        if (this.fail) {
            throw new Error('upstream 403');
        }
        const inverse = String(from) === 'CNY';
        this.inner.set(key, {
            cash: fraction(inverse ? 0.14 : 7),
            remit: fraction(inverse ? 0.13 : 8),
            middle: fraction(inverse ? 0.135 : 7.5),
            updated: new Date('2026-08-01T00:00:00Z'),
        });
        return this.fxRateList[from][to];
    }

    public async getUpdatedDate(from: currency, to: currency): Promise<Date> {
        const rate = await this.getfxRateList(from, to);
        const updated = rate?.updated;
        if (!(updated instanceof Date)) {
            throw new Error(`FX Path from ${from} to ${to} not found`);
        }
        return updated;
    }

    constructor() {
        super([]);
    }
}

const bankRates = [
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

const adapterServer = (app: rootRouter): Server =>
    (app.adapater as unknown as { server: Server }).server;

const listenApp = async (app: rootRouter): Promise<number> => {
    await app.listen(0);
    const server = adapterServer(app);
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

const httpRequest = (
    port: number,
    options: {
        method?: string;
        path?: string;
        headers?: Record<string, string>;
    },
    writeBody?: (req: http.ClientRequest) => void,
): Promise<HttpResponse> =>
    new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: '127.0.0.1',
                port,
                path: options.path ?? '/',
                method: options.method ?? 'POST',
                headers: options.headers,
                agent: false,
            },
            (res: http.IncomingMessage) => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (chunk: string) => {
                    body += chunk;
                });
                res.on('end', () =>
                    resolve({
                        status: res.statusCode ?? 0,
                        body,
                        headers: res.headers as HttpResponse['headers'],
                    }),
                );
            },
        );
        req.on('error', reject);
        req.setTimeout(10000, () =>
            req.destroy(new Error('client request timeout')),
        );
        if (writeBody) writeBody(req);
        else req.end();
    });

const postJson = (
    port: number,
    path: string,
    body: unknown,
): Promise<HttpResponse> =>
    httpRequest(
        port,
        {
            method: 'POST',
            path,
            headers: { 'Content-Type': 'application/json' },
        },
        (req) => req.end(JSON.stringify(body)),
    );

const buildRpcApp = (manager: fxmManager): rootRouter => {
    const app = new rootRouter();
    app.use([manager], '/(.*)');
    app.use([manager], '/v1/(.*)');
    app.useMappingAdapter();
    servers.push(adapterServer(app));
    return app;
};

describe('Card type=all preheat once (Phase 1, offline)', () => {
    let card: FakeCardFXM;
    let manager: fxmManager;

    beforeEach(() => {
        card = new FakeCardFXM();
        manager = new fxmManager({});
        manager.registerFXM('card', card);
        managers.push(manager);
    });

    test('success: one type=all request preheats once and reuses warmed data', async () => {
        const res = await useInternalRestAPI('card/USD/CNY/', manager);
        expect(card.networkAttempts).toBe(1);
        expect(res).toEqual({
            cash: 700,
            middle: 750,
            remit: 800,
            updated: 'Sat, 01 Aug 2026 00:00:00 GMT',
        });
    });

    test('success: second request for the same pair hits cache with zero new preheat', async () => {
        await useInternalRestAPI('card/USD/CNY/', manager);
        const res = await useInternalRestAPI('card/USD/CNY/', manager);
        expect(card.networkAttempts).toBe(1);
        expect(res).toEqual({
            cash: 700,
            middle: 750,
            remit: 800,
            updated: 'Sat, 01 Aug 2026 00:00:00 GMT',
        });
    });

    test('failure: upstream 403 preheats once and keeps the all-false response shape', async () => {
        card.fail = true;
        const res = await useInternalRestAPI('card/USD/CNY/', manager);
        expect(card.networkAttempts).toBe(1);
        expect(res).toEqual({
            cash: false,
            middle: false,
            remit: false,
            updated: expect.any(String),
        });
    });

    test('reverse: direction semantics preserved, forward and inverse pairs preheat once each', async () => {
        const res = await useInternalRestAPI('card/USD/CNY/?reverse', manager);
        expect(card.networkAttempts).toBe(2);
        expect(res).toEqual({
            cash: 14,
            middle: 13.5,
            remit: 13,
            updated: 'Sat, 01 Aug 2026 00:00:00 GMT',
        });
    });

    test('self pair (from===to) keeps conversion even without a preheated rate', async () => {
        const res = await useInternalRestAPI('card/USD/USD/', manager);
        expect(card.networkAttempts).toBe(1);
        expect(res).toEqual({
            cash: 100,
            middle: 100,
            remit: 100,
            updated: 'Sat, 01 Aug 2026 00:00:00 GMT',
        });
    });

    test('bfs=1 keeps the path semantics with one preheat', async () => {
        const res = await useInternalRestAPI('card/USD/CNY/?bfs=1', manager);
        expect(card.networkAttempts).toBe(1);
        expect(res).toEqual({
            cash: 700,
            middle: 750,
            path: ['CNY'],
            remit: 800,
            updated: 'Sat, 01 Aug 2026 00:00:00 GMT',
        });
    });

    test('single-type route failure: one preheat, body false, no second network attempt', async () => {
        card.fail = true;
        const res = await useInternalRestAPI('card/USD/CNY/cash', manager);
        expect(card.networkAttempts).toBe(1);
        expect(res).toBe(false);
    });

    test('RPC getFXRate type=all end-to-end: one preheat and full result', async () => {
        const app = buildRpcApp(manager);
        const port = await listenApp(app);
        const res = await postJson(port, '/v1/jsonrpc', {
            jsonrpc: '2.0',
            id: 'card-all',
            method: 'getFXRate',
            params: {
                source: 'card',
                from: 'USD',
                to: 'CNY',
                type: 'all',
                precision: 4,
                amount: 100,
            },
        });
        expect(res.status).toBe(200);
        const body = JSON.parse(res.body) as {
            id: string;
            result: {
                cash: number;
                middle: number;
                remit: number;
                updated: string;
            };
        };
        expect(body.id).toBe('card-all');
        expect(card.networkAttempts).toBe(1);
        expect(body.result).toEqual({
            cash: 700,
            middle: 750,
            remit: 800,
            updated: 'Sat, 01 Aug 2026 00:00:00 GMT',
        });
    });

    test('REST type=all keeps the rate-updated Date header and Cache-Control', async () => {
        const app = buildRpcApp(manager);
        const port = await listenApp(app);
        const res = await httpRequest(port, {
            method: 'GET',
            path: '/card/USD/CNY/',
        });
        expect(res.status).toBe(200);
        const body = JSON.parse(res.body) as { updated: string };
        expect(card.networkAttempts).toBe(1);
        expect(res.headers['date']).toBe(body.updated);
        expect(res.headers['cache-control']).toContain('public, max-age=');
    });
});

describe('non-Card behavior unchanged (offline)', () => {
    let manager: fxmManager;

    beforeEach(() => {
        // 预加载的 fxManager 实例（registerFXM → ready）：避免 registerGetter 的
        // 懒加载 5s 超时 timer 在 detectOpenHandles 下泄漏。
        manager = new fxmManager({});
        manager.registerFXM(
            'bank',
            new fxManager(bankRates as unknown as FXRate[]),
        );
        managers.push(manager);
    });

    test('getter source type=all output shape and values unchanged', async () => {
        const res = await useInternalRestAPI('bank/USD/CNY/', manager);
        expect(res).toEqual({
            cash: 650,
            middle: 675,
            remit: 660,
            updated: 'Sat, 01 Aug 2026 00:00:00 GMT',
        });
    });

    test('missing pair on a getter source keeps the all-false shape', async () => {
        const res = await useInternalRestAPI('bank/USD/JPY/', manager);
        expect(res).toEqual({
            cash: false,
            middle: false,
            remit: false,
            updated: expect.any(String),
        });
    });

    test('single-type getter source returns the same value as before', async () => {
        const res = await useInternalRestAPI('bank/USD/CNY/cash', manager);
        expect(res).toBe(650);
    });
});
