// rpc-rest-parity（Phase 3 REST/JSON-RPC golden parity，offline）：
// 同一请求在 REST（GET /:source/...）与 JSON-RPC（POST /v1/jsonrpc）两条 wire 上的
// 输出逐字节一致——单对详情 / 全表 / 源信息 / instanceInfo 的 JSON result 与 REST body
// 深相等；单类型换算（/:from/:to/:type）是纯文本 body，JSON-RPC result 必须与
// REST 纯文本语义一致（数值型仍为 number、false 降级仍为 false）。
// 回归重点：single-type + precision=-1 的循环小数串（非 JSON，如 "14.(285714)"）
// 此前 useInternalRestAPI 的 JSON.parse 失败会回落返回整个 response 实例，
// 导致 JSON-RPC result 变成 {status, headers, body} 响应对象（wire schema 破坏）。
// 修复后 result 直接是 body 字符串，与 REST 纯文本输出一致。
// fixture 与 fx-manager-golden.test.ts 相同的固定汇率图（updated 固定，确定性输出）。

import http, { type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rootRouter } from 'handlers.js';

import fxmManager from '../../src/fxmManager';
import { installRequestBodyLimit } from '../../src/handler/limits';
import { currency, FXRate } from '../../src/types';

interface HttpResponse {
    status: number;
    body: string;
    headers: http.IncomingHttpHeaders;
}

let cacheDir: string;
let server: Server | undefined;
let manager: fxmManager | undefined;
let port = 0;

const fixtureRates = (): FXRate[] => [
    {
        currency: { from: currency.USD, to: currency.HKD },
        rate: {
            buy: { cash: 7.75, remit: 7.78 },
            sell: { cash: 7.8, remit: 7.82 },
            middle: 7.78,
        },
        unit: 1,
        updated: new Date('2026-08-01T00:00:00Z'),
    },
    {
        currency: { from: currency.HKD, to: currency.CNH },
        rate: {
            buy: { cash: 0.9, remit: 0.9 },
            sell: { cash: 0.92, remit: 0.92 },
            middle: 0.91,
        },
        unit: 1,
        updated: new Date('2026-08-02T00:00:00Z'),
    },
    {
        currency: { from: currency.EUR, to: currency.CNH },
        rate: { middle: 7.6 },
        unit: 1,
        updated: new Date('2026-08-03T00:00:00Z'),
    },
    {
        currency: { from: currency.USD, to: currency.CNY },
        rate: {
            buy: { cash: 6.9, remit: 6.95 },
            sell: { cash: 7.05, remit: 7.1 },
            middle: 7,
        },
        unit: 1,
        updated: new Date('2026-08-04T00:00:00Z'),
    },
];

const adapterServer = (app: rootRouter): Server =>
    (app.adapater as unknown as { server: Server }).server;

const listenApp = async (app: rootRouter): Promise<number> => {
    await app.listen(0);
    const srv = adapterServer(app);
    if (!srv.listening) {
        await new Promise<void>((resolve, reject) => {
            srv.once('listening', () => resolve());
            srv.once('error', reject);
        });
    }
    const addr = srv.address();
    if (addr === null || typeof addr === 'string') {
        throw new Error('unexpected server address');
    }
    return addr.port;
};

const httpRequest = (
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
                method: options.method ?? 'GET',
                headers: options.headers,
                agent: false,
            },
            (res) => {
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (chunk: string) => {
                    body += chunk;
                });
                res.on('end', () =>
                    resolve({
                        status: res.statusCode ?? 0,
                        body,
                        headers: res.headers,
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

const getRest = (path: string): Promise<HttpResponse> =>
    httpRequest({ method: 'GET', path });

const rpcCall = (
    method: string,
    params: Record<string, unknown>,
): Promise<{ result?: unknown; error?: { code: number } }> =>
    httpRequest(
        {
            method: 'POST',
            path: '/v1/jsonrpc',
            headers: { 'Content-Type': 'application/json' },
        },
        (req) =>
            req.end(
                JSON.stringify({
                    jsonrpc: '2.0',
                    id: 'parity',
                    method,
                    params,
                }),
            ),
    ).then((res) => {
        expect(res.status).toBe(200);
        return JSON.parse(res.body) as {
            result?: unknown;
            error?: { code: number };
        };
    });

const expectPairParity = async (
    from: string,
    to: string,
    query: string,
    params: Record<string, unknown>,
): Promise<void> => {
    const rest = await getRest(`/fake/${from}/${to}${query}`);
    const rpc = await rpcCall('getFXRate', {
        source: 'fake',
        from,
        to,
        type: 'all',
        ...params,
    });
    expect(rest.status).toBe(200);
    expect(rpc.error).toBeUndefined();
    expect(rpc.result).toEqual(JSON.parse(rest.body));
};

const expectSingleTypeParity = async (
    from: string,
    to: string,
    type: string,
    query: string,
    params: Record<string, unknown>,
): Promise<unknown> => {
    const rest = await getRest(`/fake/${from}/${to}/${type}${query}`);
    const rpc = await rpcCall('getFXRate', {
        source: 'fake',
        from,
        to,
        type,
        ...params,
    });
    expect(rest.status).toBe(200);
    expect(rpc.error).toBeUndefined();
    // REST 单类型是纯文本 body；JSON-RPC result 解析后与纯文本语义一致
    // （数值仍为 number、循环小数串仍为原样字符串、降级 false 仍为 false）。
    expect(String(rpc.result)).toBe(rest.body);
    return rpc.result;
};

beforeAll(async () => {
    cacheDir = mkdtempSync(join(tmpdir(), 'fxrate-rpc-parity-'));
    process.env.FXRATE_CACHE_DIR = cacheDir;
    process.env.LOG_LEVEL = 'error';

    manager = new fxmManager({
        fake: async () => fixtureRates(),
    });

    const app = new rootRouter();
    // 与 rpc-limits.test.ts 相同的挂载顺序：`/(.*)` 在前、`/v1/(.*)` 在后。
    app.use([manager], '/(.*)');
    app.use([manager], '/v1/(.*)');
    app.useMappingAdapter();
    installRequestBodyLimit(app.adapater);
    server = adapterServer(app);
    port = await listenApp(app);
});

afterAll(async () => {
    if (server) server.close();
    if (manager) await manager.stopAllInterval();
    delete process.env.FXRATE_CACHE_DIR;
    delete process.env.LOG_LEVEL;
    rmSync(cacheDir, { recursive: true, force: true });
});

describe('parity: pair details (getFXRate type=all)', () => {
    test('USD→CNY direct matches REST body', async () => {
        await expectPairParity('USD', 'CNY', '?precision=5', {
            precision: 5,
            amount: 100,
        });
        const rpc = await rpcCall('getFXRate', {
            source: 'fake',
            from: 'USD',
            to: 'CNY',
            type: 'all',
            precision: 5,
            amount: 100,
        });
        expect(rpc.result).toEqual({
            updated: 'Tue, 04 Aug 2026 00:00:00 GMT',
            cash: 690,
            remit: 695,
            middle: 700,
        });
    });

    test('CNY→USD reverse side matches REST body', async () => {
        await expectPairParity('CNY', 'USD', '?precision=5', {
            precision: 5,
            amount: 100,
        });
        const rpc = await rpcCall('getFXRate', {
            source: 'fake',
            from: 'CNY',
            to: 'USD',
            type: 'all',
            precision: 5,
        });
        expect(rpc.result).toEqual({
            updated: 'Tue, 04 Aug 2026 00:00:00 GMT',
            cash: 14.1844,
            remit: 14.08451,
            middle: 14.28571,
        });
    });

    test('amount/fees/precision query parity', async () => {
        await expectPairParity('USD', 'CNY', '?amount=500&fees=2&precision=4', {
            precision: 4,
            amount: 500,
            fees: 2,
        });
    });

    test('BFS multi-hop path parity (path array order preserved)', async () => {
        await expectPairParity('USD', 'EUR', '?bfs=1&precision=5', {
            precision: 5,
            bfs: true,
        });
        const rpc = await rpcCall('getFXRate', {
            source: 'fake',
            from: 'USD',
            to: 'EUR',
            type: 'all',
            precision: 5,
            bfs: true,
        });
        expect(rpc.result).toEqual({
            updated: 'Mon, 03 Aug 2026 00:00:00 GMT',
            path: ['USD', 'CNY', 'EUR'],
            cash: 90.78947,
            remit: 91.44737,
            middle: 92.10526,
        });
    });

    test('BFS CNY/CNH alias parity (alias field + normalized path)', async () => {
        await expectPairParity('HKD', 'CNY', '?bfs=1&precision=5', {
            precision: 5,
            bfs: true,
        });
        const rpc = await rpcCall('getFXRate', {
            source: 'fake',
            from: 'HKD',
            to: 'CNY',
            type: 'all',
            precision: 5,
            bfs: true,
        });
        expect(rpc.result).toEqual({
            updated: 'Sun, 02 Aug 2026 00:00:00 GMT',
            path: ['CNY'],
            alias: 'CNH',
            cash: 90,
            remit: 90,
            middle: 91,
        });
    });

    test('reverse flag parity', async () => {
        await expectPairParity('CNY', 'USD', '?reverse&precision=5', {
            precision: 5,
            reverse: true,
        });
    });
});

describe('parity: single-type convert (getFXRate type=cash/remit/middle)', () => {
    test('numeric precision 2 parity for all three types', async () => {
        await expectSingleTypeParity('CNY', 'USD', 'cash', '?precision=2', {
            precision: 2,
        });
        await expectSingleTypeParity('CNY', 'USD', 'remit', '?precision=2', {
            precision: 2,
        });
        await expectSingleTypeParity('CNY', 'USD', 'middle', '?precision=2', {
            precision: 2,
        });
    });

    test('precision 0 and 6 parity', async () => {
        await expectSingleTypeParity('CNY', 'USD', 'cash', '?precision=0', {
            precision: 0,
        });
        await expectSingleTypeParity('CNY', 'USD', 'cash', '?precision=6', {
            precision: 6,
        });
    });

    test('precision -1 exact integer stays numeric on both transports', async () => {
        const rpc = await expectSingleTypeParity(
            'USD',
            'CNY',
            'middle',
            '?precision=-1',
            { precision: -1 },
        );
        expect(rpc).toBe(700);
    });

    test('precision -1 repeating fractions match REST plain-text (wire fix)', async () => {
        const cash = await expectSingleTypeParity(
            'CNY',
            'USD',
            'cash',
            '?precision=-1',
            { precision: -1 },
        );
        expect(cash).toBe(
            '14.(1843971631205673758865248226950354609929078014)',
        );
        const remit = await expectSingleTypeParity(
            'CNY',
            'USD',
            'remit',
            '?precision=-1',
            { precision: -1 },
        );
        expect(remit).toBe('14.(08450704225352112676056338028169014)');
        const middle = await expectSingleTypeParity(
            'CNY',
            'USD',
            'middle',
            '?precision=-1',
            { precision: -1 },
        );
        expect(middle).toBe('14.(285714)');
    });

    test('precision -1 with amount/fees keeps string parity', async () => {
        const rpc = await expectSingleTypeParity(
            'CNY',
            'USD',
            'middle',
            '?precision=-1&amount=500&fees=1',
            { precision: -1, amount: 500, fees: 1 },
        );
        expect(typeof rpc).toBe('string');
    });

    test('source unavailable degradation contract on both transports', async () => {
        // USD→EUR 无直连报价、无 BFS：getConvert 抛错 → REST 纯文本 "false"。
        // JSON-RPC 侧 v2ToHandler 的 `if (tmp)` 把 falsy 的 false 强转为 null
        // （handlers.js-jsonrpc 既有行为，勿改）——两条 wire 的降级契约分别锁定。
        const rest = await getRest('/fake/USD/EUR/cash?precision=2');
        expect(rest.status).toBe(200);
        expect(rest.body).toBe('false');
        const rpc = await rpcCall('getFXRate', {
            source: 'fake',
            from: 'USD',
            to: 'EUR',
            type: 'cash',
            precision: 2,
        });
        expect(rpc.error).toBeUndefined();
        expect(rpc.result).toBeNull();
    });
});

describe('parity: full table / source info / instance info', () => {
    test('listFXRates matches REST full-table', async () => {
        const rest = await getRest('/fake/USD?precision=2');
        const rpc = await rpcCall('listFXRates', {
            source: 'fake',
            from: 'USD',
            precision: 2,
            amount: 100,
            fees: 0,
        });
        expect(rest.status).toBe(200);
        expect(rpc.error).toBeUndefined();
        expect(rpc.result).toEqual(JSON.parse(rest.body));
    });

    test('listFXRates with bfs matches REST full-table', async () => {
        const rest = await getRest('/fake/USD?bfs=1&precision=2');
        const rpc = await rpcCall('listFXRates', {
            source: 'fake',
            from: 'USD',
            precision: 2,
            bfs: true,
        });
        expect(rpc.result).toEqual(JSON.parse(rest.body));
    });

    test('listCurrencies matches REST source info', async () => {
        const rest = await getRest('/fake/');
        const parsed = JSON.parse(rest.body) as {
            currency: string[];
            date: string;
        };
        const rpc = await rpcCall('listCurrencies', { source: 'fake' });
        expect(rpc.error).toBeUndefined();
        const result = rpc.result as { currency: string[]; date: string };
        expect(result.currency).toEqual(parsed.currency);
        // HKD→CNH fixture 的反向边写入使 CNH 也成为 from 货币，故共 4 个。
        expect(result.currency.sort()).toEqual(['CNH', 'EUR', 'HKD', 'USD']);
        // date 为服务器当前时间（跨秒会漂移），只校验格式合法且两者都是日期字符串。
        expect(new Date(result.date).getTime()).not.toBeNaN();
        expect(new Date(parsed.date).getTime()).not.toBeNaN();
    });

    test('instanceInfo matches REST /info body', async () => {
        const rest = await getRest('/info');
        const rpc = await rpcCall('instanceInfo', {});
        expect(rpc.error).toBeUndefined();
        expect(rpc.result).toEqual(JSON.parse(rest.body));
        // 最小 manager 只注册了非关键源 fake：readiness 门禁下 status 为 degraded。
        const result = rpc.result as { status: string; sources: string[] };
        expect(result.status).toBe('degraded');
        expect(result.sources).toEqual(['fake']);
    });
});
