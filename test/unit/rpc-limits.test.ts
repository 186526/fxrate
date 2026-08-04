// rpc-limits（Phase 1 RPC 入口硬限制，offline）：
//  一、HTTP body 上限 256 KiB：真实 NodePlatformAdapter（rootRouter + useMappingAdapter）
//      装上 installRequestBodyLimit 后验证——Content-Length 预检 413、chunked 流式溢出 413、
//      精确边界 262144 成功、abort 后读取 settle 且服务仍可用、413 时零 handler 工作。
//  二、JSON-RPC v2 预算：真实 fxmManager + 真实路由下，批量 >100 或昂贵卡组织条目 >20
//      （getFXRate source=visa/mastercard）时返回稳定 JSON-RPC 错误（HTTP 200），
//      且逐条 dispatch（_v2RPCsingleResponder）/ 数据源 getter 零触发；精确边界成功。
//  全部走回环地址，全程不访问公网。--detectOpenHandles 兜底无挂起 Promise / 句柄泄漏。

import http, { type Server } from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { jest } from '@jest/globals';

import { rootRouter } from 'handlers.js';

import fxmManager from '../../src/fxmManager';
import {
    countExpensiveCardItems,
    installRequestBodyLimit,
    MAX_REQUEST_BODY_BYTES,
    RPC_BATCH_TOO_LARGE,
    RPC_EXPENSIVE_CARD_LIMIT,
    RPC_MAX_BATCH_SIZE,
    RPC_MAX_EXPENSIVE_CARD_ITEMS,
    type RPCBudgetError,
} from '../../src/handler/limits';

interface HttpResponse {
    status: number;
    body: string;
    headers: http.IncomingHttpHeaders;
}

const servers: Server[] = [];
const managers: fxmManager[] = [];

let cacheDir: string;

beforeAll(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'fxrate-rpc-limits-'));
    process.env.FXRATE_CACHE_DIR = cacheDir;
    process.env.LOG_LEVEL = 'error';
});

afterAll(() => {
    delete process.env.FXRATE_CACHE_DIR;
    delete process.env.LOG_LEVEL;
    rmSync(cacheDir, { recursive: true, force: true });
});

afterEach(async () => {
    jest.restoreAllMocks();
    for (const server of servers) server.close();
    servers.length = 0;
    // stopAllInterval 现经节流异步 writer flush 落盘：须 await 完成才能让 afterAll
    // 删除临时目录，否则后台 fs 写与 rmSync 并发产生杂散 ENOENT。
    await Promise.allSettled(managers.map((m) => m.stopAllInterval()));
    managers.length = 0;
});

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

const postChunked = (
    port: number,
    path: string,
    chunks: string[],
): Promise<HttpResponse> =>
    httpRequest(
        port,
        { method: 'POST', path, headers: { 'Content-Type': 'text/plain' } },
        (req) => {
            for (const chunk of chunks) req.write(chunk);
            req.end();
        },
    );

const buildEchoApp = (): {
    app: rootRouter;
    getHandlerCalls: () => number;
} => {
    let handlerCalls = 0;
    const app = new rootRouter();
    app.binding(
        '/echo',
        app.create('POST', async (req) => {
            handlerCalls += 1;
            return String(String(req.body).length);
        }),
    );
    app.useMappingAdapter();
    installRequestBodyLimit(app.adapater);
    servers.push(adapterServer(app));
    return { app, getHandlerCalls: () => handlerCalls };
};

const buildRpcApp = (): {
    app: rootRouter;
    manager: fxmManager;
    getGetterCalls: () => number;
} => {
    let getterCalls = 0;
    const manager = new fxmManager({
        fake: async () => {
            getterCalls += 1;
            return [];
        },
    });
    managers.push(manager);
    const app = new rootRouter();
    // 与 src/index.ts makeInstance 相同的挂载顺序：`/(.*)` 在前、`/v1/(.*)` 在后，
    // 保证 /v1/jsonrpc 只被后一个子路由命中一次（handlers.js _respond 循环会复用被
    // 子路由改写过的 request.url.pathname，顺序颠倒会导致同一请求被 dispatch 两次）。
    app.use([manager], '/(.*)');
    app.use([manager], '/v1/(.*)');
    app.useMappingAdapter();
    installRequestBodyLimit(app.adapater);
    servers.push(adapterServer(app));
    return { app, manager, getGetterCalls: () => getterCalls };
};

const expectBudgetError = (
    res: HttpResponse,
    expected: RPCBudgetError,
): void => {
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    const body = JSON.parse(res.body) as {
        jsonrpc: string;
        id: unknown;
        error?: RPCBudgetError;
    };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBeNull();
    expect(body.error).toEqual(expected);
};

const rpcItem = (
    method: string,
    id: number | string,
    params?: unknown,
): Record<string, unknown> => ({
    jsonrpc: '2.0',
    id,
    method,
    ...(params !== undefined ? { params } : {}),
});

const makeBatch = (
    n: number,
    method = 'instanceInfo',
    params?: unknown,
): unknown[] =>
    Array.from({ length: n }, (_, i) => rpcItem(method, `id-${i}`, params));

const visaParams = { source: 'visa', from: 'USD', to: 'CNY', type: 'all' };

describe('RPC body limit (256 KiB, real NodePlatformAdapter)', () => {
    test('exact Content-Length boundary (262144 bytes) succeeds', async () => {
        const { app, getHandlerCalls } = buildEchoApp();
        const port = await listenApp(app);
        const body = 'a'.repeat(MAX_REQUEST_BODY_BYTES);
        const res = await httpRequest(
            port,
            { method: 'POST', path: '/echo' },
            (req) => req.end(body),
        );
        expect(res.status).toBe(200);
        expect(res.body).toBe(String(MAX_REQUEST_BODY_BYTES));
        expect(getHandlerCalls()).toBe(1);
    });

    test('Content-Length over the limit is rejected with 413 before any handler work', async () => {
        const { app, getHandlerCalls } = buildEchoApp();
        const port = await listenApp(app);
        const res = await httpRequest(
            port,
            {
                method: 'POST',
                path: '/echo',
                headers: {
                    'Content-Length': String(MAX_REQUEST_BODY_BYTES + 1),
                },
            },
            (req) => req.end('x'.repeat(100)),
        );
        expect(res.status).toBe(413);
        expect(res.body).toContain('Payload Too Large');
        expect(getHandlerCalls()).toBe(0);
        expect(res.headers['connection']?.toLowerCase()).toContain('close');
    });

    test('chunked body overflowing the limit is rejected with 413', async () => {
        const { app, getHandlerCalls } = buildEchoApp();
        const port = await listenApp(app);
        const res = await postChunked(port, '/echo', [
            'a'.repeat(200000),
            'b'.repeat(62145),
        ]);
        expect(res.status).toBe(413);
        expect(res.body).toContain('Payload Too Large');
        expect(getHandlerCalls()).toBe(0);
    });

    test('chunked body exactly at the boundary succeeds', async () => {
        const { app, getHandlerCalls } = buildEchoApp();
        const port = await listenApp(app);
        const res = await postChunked(port, '/echo', [
            'a'.repeat(200000),
            'b'.repeat(MAX_REQUEST_BODY_BYTES - 200000),
        ]);
        expect(res.status).toBe(200);
        expect(res.body).toBe(String(MAX_REQUEST_BODY_BYTES));
        expect(getHandlerCalls()).toBe(1);
    });

    test('aborted mid-stream body settles and the server stays usable', async () => {
        const { app } = buildEchoApp();
        const port = await listenApp(app);
        await new Promise<void>((resolve) => {
            const sock = net.connect({ host: '127.0.0.1', port }, () => {
                sock.write(
                    'POST /echo HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n',
                );
                sock.write('400\r\n' + 'a'.repeat(1024) + '\r\n');
                setTimeout(() => {
                    sock.destroy();
                    resolve();
                }, 50);
            });
            sock.on('error', () => resolve());
        });
        // 给服务端一两个 tick 完成 abort 后的 settle
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
        const res = await postJson(port, '/echo', 'still-works');
        expect(res.status).toBe(200);
        // JSON.stringify('still-works') → 带引号共 13 字节
        expect(res.body).toBe('13');
    });

    test('default handler path (handleRequest → respond → handleResponse) rejects over-limit body', async () => {
        const { app, getHandlerCalls } = buildEchoApp();
        // 模拟 src/index.ts 默认导出：直接走 adapter 的三步管线，不经 adapter.listen。
        const dispatch = async (
            req: http.IncomingMessage,
            res: http.ServerResponse,
        ): Promise<void> => {
            const request = await app.adapater.handleRequest(req);
            const response = await app.adapater.router.respond(request);
            app.adapater.handleResponse(response, res);
        };
        const server = http.createServer((req, res) => void dispatch(req, res));
        servers.push(server);
        await new Promise<void>((resolve) =>
            server.listen(0, '127.0.0.1', resolve),
        );
        const port = (server.address() as net.AddressInfo).port;
        const res = await httpRequest(
            port,
            {
                method: 'POST',
                path: '/echo',
                headers: {
                    'Content-Length': String(MAX_REQUEST_BODY_BYTES + 1),
                },
            },
            (req) => req.end('x'.repeat(100)),
        );
        expect(res.status).toBe(413);
        expect(getHandlerCalls()).toBe(0);
    });

    test('over-limit body on /v1/jsonrpc returns 413 before any RPC dispatch', async () => {
        const { app, manager } = buildRpcApp();
        const port = await listenApp(app);
        const singleResponderSpy = jest.spyOn(manager, '_v2RPCsingleResponder');
        const res = await postJson(port, '/v1/jsonrpc', {
            jsonrpc: '2.0',
            id: 'x',
            method: 'instanceInfo',
            data: 'a'.repeat(MAX_REQUEST_BODY_BYTES),
        });
        expect(res.status).toBe(413);
        expect(singleResponderSpy).not.toHaveBeenCalled();
    });
});

describe('RPC budget (real fxmManager + real routing)', () => {
    test('countExpensiveCardItems counts only getFXRate with visa/mastercard named params', () => {
        expect(
            countExpensiveCardItems([
                rpcItem('getFXRate', 1, {
                    source: 'visa',
                    from: 'USD',
                    to: 'CNY',
                }),
                rpcItem('getFXRate', 2, {
                    source: 'mastercard',
                    from: 'USD',
                    to: 'JPY',
                }),
                rpcItem('getFXRate', 3, {
                    source: 'boc',
                    from: 'USD',
                    to: 'CNY',
                }),
                rpcItem('listFXRates', 4, { source: 'visa', from: 'USD' }),
                rpcItem('getFXRate', 5),
                {
                    jsonrpc: '2.0',
                    id: 6,
                    method: 'getFXRate',
                    params: ['visa', 'USD', 'CNY'],
                },
                rpcItem('getFXRate', 7, { source: 'VISA' }),
            ]),
        ).toBe(2);
    });

    test('over-batch (101 items) returns -32000 with zero dispatch and zero getter work', async () => {
        const { app, manager, getGetterCalls } = buildRpcApp();
        const port = await listenApp(app);
        const singleResponderSpy = jest.spyOn(manager, '_v2RPCsingleResponder');
        const res = await postJson(
            port,
            '/v1/jsonrpc',
            makeBatch(RPC_MAX_BATCH_SIZE + 1, 'listCurrencies', {
                source: 'fake',
            }),
        );
        expectBudgetError(res, RPC_BATCH_TOO_LARGE);
        expect(singleResponderSpy).not.toHaveBeenCalled();
        expect(getGetterCalls()).toBe(0);
    });

    test('over-batch also enforced on the /jsonrpc path', async () => {
        const { app, manager } = buildRpcApp();
        const port = await listenApp(app);
        const singleResponderSpy = jest.spyOn(manager, '_v2RPCsingleResponder');
        const res = await postJson(
            port,
            '/jsonrpc',
            makeBatch(RPC_MAX_BATCH_SIZE + 1),
        );
        expectBudgetError(res, RPC_BATCH_TOO_LARGE);
        expect(singleResponderSpy).not.toHaveBeenCalled();
    });

    test('exact batch boundary (100 items) is dispatched', async () => {
        const { app, manager } = buildRpcApp();
        const port = await listenApp(app);
        const singleResponderSpy = jest.spyOn(manager, '_v2RPCsingleResponder');
        const res = await postJson(
            port,
            '/v1/jsonrpc',
            makeBatch(RPC_MAX_BATCH_SIZE),
        );
        expect(res.status).toBe(200);
        const body = JSON.parse(res.body) as Array<{
            id: string;
            result?: { status?: string };
        }>;
        expect(Array.isArray(body)).toBe(true);
        expect(body).toHaveLength(RPC_MAX_BATCH_SIZE);
        expect(singleResponderSpy).toHaveBeenCalledTimes(RPC_MAX_BATCH_SIZE);
        // readiness 门禁：本测试 manager 只注册了非关键源 fake，关键源缺失 →
        // /info status 为 degraded（instanceInfo 经内部 REST 复用同一 /info）。
        expect(body[0].result?.status).toBe('degraded');
        expect(body[body.length - 1].id).toBe(`id-${RPC_MAX_BATCH_SIZE - 1}`);
    });

    test('over-cost (21 getFXRate visa) returns -32001 with zero dispatch', async () => {
        const { app, manager, getGetterCalls } = buildRpcApp();
        const port = await listenApp(app);
        const singleResponderSpy = jest.spyOn(manager, '_v2RPCsingleResponder');
        const res = await postJson(
            port,
            '/v1/jsonrpc',
            makeBatch(
                RPC_MAX_EXPENSIVE_CARD_ITEMS + 1,
                'getFXRate',
                visaParams,
            ),
        );
        expectBudgetError(res, RPC_EXPENSIVE_CARD_LIMIT);
        expect(singleResponderSpy).not.toHaveBeenCalled();
        expect(getGetterCalls()).toBe(0);
    });

    test('exact cost boundary (20 getFXRate visa) is dispatched', async () => {
        const { app, manager } = buildRpcApp();
        const port = await listenApp(app);
        const singleResponderSpy = jest.spyOn(manager, '_v2RPCsingleResponder');
        const res = await postJson(
            port,
            '/v1/jsonrpc',
            makeBatch(RPC_MAX_EXPENSIVE_CARD_ITEMS, 'getFXRate', visaParams),
        );
        expect(res.status).toBe(200);
        const body = JSON.parse(res.body) as unknown[];
        expect(Array.isArray(body)).toBe(true);
        expect(body).toHaveLength(RPC_MAX_EXPENSIVE_CARD_ITEMS);
        expect(singleResponderSpy).toHaveBeenCalledTimes(
            RPC_MAX_EXPENSIVE_CARD_ITEMS,
        );
    });

    test('mixed batch under both budgets is dispatched (20 card + 80 cheap)', async () => {
        const { app, manager } = buildRpcApp();
        const port = await listenApp(app);
        const singleResponderSpy = jest.spyOn(manager, '_v2RPCsingleResponder');
        const res = await postJson(port, '/v1/jsonrpc', [
            ...makeBatch(RPC_MAX_EXPENSIVE_CARD_ITEMS, 'getFXRate', visaParams),
            ...makeBatch(RPC_MAX_BATCH_SIZE - RPC_MAX_EXPENSIVE_CARD_ITEMS),
        ]);
        expect(res.status).toBe(200);
        expect(JSON.parse(res.body)).toHaveLength(RPC_MAX_BATCH_SIZE);
        expect(singleResponderSpy).toHaveBeenCalledTimes(RPC_MAX_BATCH_SIZE);
    });

    test('content query path is enforced and preserved', async () => {
        const { app, manager } = buildRpcApp();
        const port = await listenApp(app);
        const singleResponderSpy = jest.spyOn(manager, '_v2RPCsingleResponder');
        const content = JSON.stringify(makeBatch(RPC_MAX_BATCH_SIZE + 1));
        const res = await postJson(
            port,
            '/jsonrpc?' + new URLSearchParams({ content }).toString(),
            '',
        );
        expectBudgetError(res, RPC_BATCH_TOO_LARGE);
        expect(singleResponderSpy).not.toHaveBeenCalled();

        const okRes = await postJson(
            port,
            '/jsonrpc?' +
                new URLSearchParams({
                    content: JSON.stringify({
                        jsonrpc: '2.0',
                        id: 'via-content',
                        method: 'instanceInfo',
                    }),
                }).toString(),
            '',
        );
        expect(okRes.status).toBe(200);
        const okBody = JSON.parse(okRes.body) as {
            id: string;
            result?: object;
        };
        expect(okBody.id).toBe('via-content');
        expect(okBody.result).toBeDefined();
    });

    test('single request / notification / error shapes are preserved', async () => {
        const { app } = buildRpcApp();
        const port = await listenApp(app);

        const notification = await postJson(port, '/v1/jsonrpc', {
            jsonrpc: '2.0',
            method: 'instanceInfo',
        });
        expect(notification.status).toBe(200);
        expect(notification.body).toBe('');

        const single = await postJson(port, '/v1/jsonrpc', {
            jsonrpc: '2.0',
            id: 'single-1',
            method: 'instanceInfo',
        });
        expect(single.status).toBe(200);
        const singleBody = JSON.parse(single.body) as {
            id: string;
            result?: { status?: string };
        };
        expect(singleBody.id).toBe('single-1');
        // 同上：最小 manager 关键源缺失，readiness 门禁下 status 为 degraded。
        expect(singleBody.result?.status).toBe('degraded');

        const cardError = await postJson(port, '/v1/jsonrpc', {
            jsonrpc: '2.0',
            id: 'card-1',
            method: 'getFXRate',
            params: visaParams,
        });
        expect(cardError.status).toBe(200);
        const cardBody = JSON.parse(cardError.body) as {
            id: string;
            error?: { code: number };
        };
        expect(cardBody.id).toBe('card-1');
        // visa 未注册 → 下游 -32603 错误（预算层放行单条）
        expect(cardBody.error?.code).toBe(-32603);
    });

    test('over-batch via content query on /v1/jsonrpc performs zero dispatch', async () => {
        const { app, manager } = buildRpcApp();
        const port = await listenApp(app);
        const singleResponderSpy = jest.spyOn(manager, '_v2RPCsingleResponder');
        const res = await postJson(
            port,
            '/v1/jsonrpc?' +
                new URLSearchParams({
                    content: JSON.stringify(makeBatch(RPC_MAX_BATCH_SIZE + 1)),
                }).toString(),
            '',
        );
        expectBudgetError(res, RPC_BATCH_TOO_LARGE);
        expect(singleResponderSpy).not.toHaveBeenCalled();
    });
});
