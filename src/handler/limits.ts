import http from 'node:http';
import { request, response, interfaces } from 'handlers.js';

import { recordRpcRejection } from '../metrics';

// Phase 1 RPC 入口硬限制。
//
// 一、HTTP body 上限（256 KiB）：handlers.js NodePlatformAdapter 的 handleRequest
// 会把整个请求体无上限读进内存（data 累积 + end 拼装），恶意大 body 可直接打满内存；
// 其自带 bodyLimit 中间件是「读完再查」的，防不住。本模块在 adapter 实例上替换
// handleRequest 为「Content-Length 预检 + 流式字节计数」的受限读取器：
//   - Content-Length 大于上限：尚未读取任何 body 即返回 413 标记请求；
//   - 流式计数超过上限（chunked 无 Content-Length）：停止缓冲，返回 413 标记请求；
//   - 同时监听 aborted / error / close，任一触发立即 settle，杜绝挂起的 Promise。
// 标记请求由被包装的 router.respond 在进入路由/数据源之前转成 HTTP 413。
// 另包装 handleResponse：连接已销毁时不再写响应（客户端中断场景），
// 且 413 响应强制 Connection: close + shouldKeepAlive=false（丢弃未读 body 字节）。
//
// 二、JSON-RPC v2 预算：单批最多 100 条、昂贵卡组织条目（getFXRate source=
// visa/mastercard）最多 20 条。超限返回稳定的实现自定义 JSON-RPC 错误码/消息
// （HTTP 200），且在逐条 dispatch 之前拦截——零 RPC handler / 内部 REST / 抓取工作。

export const MAX_REQUEST_BODY_BYTES = 256 * 1024;

export const RPC_MAX_BATCH_SIZE = 100;
export const RPC_MAX_EXPENSIVE_CARD_ITEMS = 20;
export const RPC_EXPENSIVE_CARD_SOURCES = new Set(['visa', 'mastercard']);

export interface RPCBudgetError {
    code: number;
    message: string;
}

export const RPC_BATCH_TOO_LARGE: RPCBudgetError = {
    code: -32000,
    message: `JSON-RPC batch exceeds the limit of ${RPC_MAX_BATCH_SIZE} requests`,
};

export const RPC_EXPENSIVE_CARD_LIMIT: RPCBudgetError = {
    code: -32001,
    message: `JSON-RPC request exceeds the limit of ${RPC_MAX_EXPENSIVE_CARD_ITEMS} expensive card requests (getFXRate source visa/mastercard)`,
};

// handlers.js NodePlatformAdapter 的句柄形状子集（真实 adapter 结构兼容）。
export interface RequestBodyLimitAdapter {
    handleRequest(nativeRequest: any): Promise<request<any>>;
    router: {
        respond(r: request<any>): Promise<response<any>>;
    };
    handleResponse(
        resp: response<any>,
        nativeResponse?: http.ServerResponse,
    ): void;
}

const BODYLESS_METHODS = new Set(['GET', 'HEAD', 'DELETE', 'OPTIONS']);

type BodyReadResult =
    | { kind: 'ok'; body: string }
    | { kind: 'reject'; reason: 'limit-exceeded' | 'read-failed' };

const ipOf = (nativeRequest: any): string =>
    nativeRequest.socket?.remoteAddress?.replace('::ffff:', '') ?? '0.0.0.0';

const makeRequest = (nativeRequest: any, body: string): request<any> =>
    new request<any>(
        nativeRequest.method,
        new URL(nativeRequest.url, 'http://localhost'),
        new interfaces.headers(nativeRequest.headers),
        body,
        {},
        ipOf(nativeRequest),
    );

// 受限 body 读取：Content-Length 预检 + 流式计数，超限不缓冲、abort/error/close 均 settle。
const readRequestBody = (
    nativeRequest: http.IncomingMessage,
    maxBytes: number,
): Promise<BodyReadResult> =>
    new Promise((resolve) => {
        const contentLength = Number(nativeRequest.headers['content-length']);
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
            // 尚未读取任何 body 即拒绝；剩余字节在 413 响应后随 socket 关闭丢弃。
            nativeRequest.resume();
            resolve({ kind: 'reject', reason: 'limit-exceeded' });
            return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        let settled = false;

        const cleanup = (): void => {
            nativeRequest.removeListener('data', onData);
            nativeRequest.removeListener('end', onEnd);
            nativeRequest.removeListener('aborted', onAbort);
            nativeRequest.removeListener('error', onError);
            nativeRequest.removeListener('close', onClose);
        };

        const settle = (result: BodyReadResult): void => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(result);
        };

        const onData = (chunk: Buffer): void => {
            size += chunk.length;
            if (size > maxBytes) {
                // 流式溢出（chunked）：停止缓冲并丢弃后续字节，杜绝内存继续增长。
                nativeRequest.removeListener('data', onData);
                nativeRequest.resume();
                settle({ kind: 'reject', reason: 'limit-exceeded' });
                return;
            }
            chunks.push(chunk);
        };

        const onEnd = (): void =>
            settle({
                kind: 'ok',
                body: Buffer.concat(chunks).toString('utf8'),
            });

        const onAbort = (): void =>
            settle({ kind: 'reject', reason: 'read-failed' });
        const onError = (): void =>
            settle({ kind: 'reject', reason: 'read-failed' });
        const onClose = (): void =>
            settle({ kind: 'reject', reason: 'read-failed' });

        nativeRequest.on('data', onData);
        nativeRequest.on('end', onEnd);
        nativeRequest.on('aborted', onAbort);
        nativeRequest.on('error', onError);
        nativeRequest.on('close', onClose);
    });

const installedAdapters = new WeakSet<object>();

export const installRequestBodyLimit = (
    adapter: RequestBodyLimitAdapter,
): void => {
    if (installedAdapters.has(adapter)) return;
    installedAdapters.add(adapter);

    const originalRespond = adapter.router.respond.bind(adapter.router);
    const originalHandleResponse = adapter.handleResponse.bind(adapter);

    adapter.handleRequest = async (
        nativeRequest: any,
    ): Promise<request<any>> => {
        if (
            typeof nativeRequest.method !== 'string' ||
            typeof nativeRequest.url !== 'string' ||
            typeof nativeRequest.headers !== 'object'
        ) {
            throw new Error('Invalid request');
        }

        let body: string = '';
        if (!BODYLESS_METHODS.has(nativeRequest.method)) {
            const result = await readRequestBody(
                nativeRequest,
                MAX_REQUEST_BODY_BYTES,
            );
            if (result.kind === 'reject') {
                const marker = makeRequest(nativeRequest, '');
                marker.custom = { requestRejected: result.reason };
                return marker;
            }
            body = result.body;
        }

        return makeRequest(nativeRequest, body);
    };

    // 标记请求在进入路由（router.respond / _respond）之前就变成 413/400 响应，
    // 并在此统一汇合点记录 body 阶段拒绝指标（Phase 6）。
    adapter.router.respond = async (
        rpcRequest: request<any>,
    ): Promise<response<any>> => {
        const reason = rpcRequest.custom?.requestRejected;
        if (reason === 'limit-exceeded') {
            recordRpcRejection('body_limit_exceeded');
            const limitResponse = new response<any>('Payload Too Large\n', 413);
            limitResponse.headers.set(
                'Content-Type',
                'text/plain; charset=utf-8',
            );
            return limitResponse;
        }
        if (reason === 'read-failed') {
            recordRpcRejection('body_read_failed');
            return new response<any>('', 400);
        }
        return originalRespond(rpcRequest);
    };

    // 连接已销毁（客户端中断）时写响应是无意义的且可能抛错，直接跳过；
    // 413 响应强制关闭连接，保证未读完的 body 字节不会污染 keep-alive 连接。
    adapter.handleResponse = (
        resp: response<any>,
        nativeResponse?: http.ServerResponse,
    ): void => {
        if (
            !nativeResponse ||
            nativeResponse.destroyed ||
            nativeResponse.writableEnded
        ) {
            return;
        }
        if (resp.status === 413) {
            nativeResponse.setHeader('Connection', 'close');
            nativeResponse.shouldKeepAlive = false;
        }
        originalHandleResponse(resp, nativeResponse);
    };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

// 统计批量中「昂贵卡组织条目」：getFXRate 且 params.source 为 visa/mastercard。
// params 需为命名参数对象；位置参数数组（无法判定 source）不计入。
export const countExpensiveCardItems = (batch: unknown): number => {
    if (!Array.isArray(batch)) return 0;
    let count = 0;
    for (const item of batch) {
        if (!isRecord(item)) continue;
        if (item.method !== 'getFXRate') continue;
        const params = item.params;
        if (!isRecord(params)) continue;
        const source = params.source;
        if (
            typeof source === 'string' &&
            RPC_EXPENSIVE_CARD_SOURCES.has(source)
        ) {
            count += 1;
        }
    }
    return count;
};
