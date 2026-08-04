import { request, response } from 'handlers.js';
import fxManager, { type FXRateType } from '../fxm/fxManager';
import { currency } from '../types';
import { round, multiply, Fraction } from 'mathjs';

import process from 'node:process';

// handlers.js 0.1.6 的 response.body 类型是 string | Uint8Array | ArrayBuffer | ReadableStream | AsyncIterable | null，
// 统一解码为 string 供 JSON.parse 使用（本服务内部写入的 body 始终是 string）。
export const bodyToString = (body: response<any>['body']): string => {
    if (typeof body === 'string') return body;
    if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8');
    if (body instanceof ArrayBuffer) {
        return Buffer.from(new Uint8Array(body)).toString('utf8');
    }
    if (body === null) return '';
    throw new Error('Unsupported response body type');
};

export const useBasic = (response: response<any>): void => {
    response.status = 200;
    response.headers.set('Date', new Date().toUTCString());

    if (process.env.ENABLE_CORS) {
        response.headers.set(
            'Access-Control-Allow-Origin',
            process.env.CORS_ORIGIN || '*',
        );
        response.headers.set(
            'Access-Control-Allow-Methods',
            'GET, POST, OPTIONS',
        );
        response.headers.set('Allow', 'GET, POST, OPTIONS');
        response.headers.set(
            'Access-Control-Expose-Headers',
            'Date, X-License, X-Author, X-Powered-By',
        );
    }
};

const sortObject = (obj: unknown): unknown => {
    if (obj instanceof Array) {
        // 数组元素有顺序语义（如 BFS 的 result.path），不参与 key 排序。
        return obj;
    }
    if (typeof obj !== 'object' || obj === null) {
        return obj;
    }
    const keys = Object.keys(obj).sort(),
        sortedObj: Record<string, unknown> = {};

    for (const key of keys) {
        sortedObj[key] = sortObject((obj as Record<string, unknown>)[key]);
    }

    return sortedObj;
};

export const useJson = (
    response: response<any>,
    request: request<any>,
): void => {
    useBasic(response);

    const answer = JSON.parse(bodyToString(response.body));
    const sortedAnswer = sortObject(answer);

    response.body = JSON.stringify(sortedAnswer);

    if (
        request.query.has('pretty') ||
        request.headers.get('Sec-Fetch-Dest') === 'document'
    ) {
        response.body = JSON.stringify(sortedAnswer, null, 4);
    }

    response.headers.set('Content-type', 'application/json; charset=utf-8');
};

export const getConvert = async (
    from: currency,
    to: currency,
    type: string,
    fxManager: fxManager,
    request: request<any>,
    amount: number = 100,
    fees: number = 0,
) => {
    let answer = await fxManager.convert(
        from,
        to,
        type as 'cash' | 'remit' | 'middle',
        Number(request.query.get('amount')) || amount || 100,
        request.query.has('reverse'),
        request.query.get('bfs') === '1' || request.query.get('bfs') === 'true',
    );
    answer = multiply(
        answer,
        1 + (Number(request.query.get('fees')) || fees) / 100,
    ) as Fraction;
    const precision = Number(request.query.get('precision') ?? 5);
    answer =
        precision !== -1
            ? round(answer, Number.isNaN(precision) ? 5 : precision)
            : answer;
    return Number(answer.toString()) || answer.toString();
};

export const getDetails = async (
    from: currency,
    to: currency,
    fxManager: fxManager,
    request: request<any>,
) => {
    const result: {
        [type: string]: string | number | boolean | string[];
    } = {
        updated: new Date().toUTCString(),
    };
    // 预热一次：getfxRateList 缓存命中时零网络；miss 时网络拉取写缓存
    // （mastercard/visa 等 Card 源），成功后 cash/remit/middle/updated
    // 全部复用已预热的 Proxy 数据，updated 取该 rate 的时间戳。
    let rate: FXRateType | undefined;
    try {
        rate = await fxManager.getfxRateList(from, to);
    } catch (_e) {
        rate = undefined;
    }
    if (rate?.updated instanceof Date) {
        result.updated = rate.updated.toUTCString();
    }
    // ?bfs=1 时回传实际经过的兑换路径（直连时也返回直连对，便于前端展示）。
    // 路径命中 CNY/CNH 别名（如图里只有 CNH 而目标为 CNY）时，result.alias 记录实际别名货币，
    // REST handler 据此设置 X-FXRate-Alias header（见 fxmManager），前端可提示「经 CNH 折算」。
    // hasPath 记录「存在可用路径（直连或 BFS）」，供下方价格计算判定——无直连报价
    // 但 BFS 可达时也要计算 cash/remit/middle，不能因为 rate undefined 就跳过。
    let hasPath = false;
    if (
        request.query.get('bfs') === '1' ||
        request.query.get('bfs') === 'true'
    ) {
        try {
            const fxp = await fxManager.getFXPath(from, to, true);
            hasPath = fxp.path.length > 0;
            result.path = fxp.path.map(String);
            if (fxp.alias) result.alias = String(fxp.alias);
            // 多段 BFS 路径（path 含 from，长度 > 1）时 updated 取路径上最旧边的
            // 更新时间；直连（path=[to]，长度 1）保持自身 updated（上方 rate 分支已设置）。
            if (fxp.path.length > 1) {
                try {
                    result.updated = (
                        await fxManager.getPathUpdatedDate(
                            fxp.path[0] === from
                                ? fxp.path
                                : [from, ...fxp.path],
                        )
                    ).toUTCString();
                } catch (_e) {
                    // 路径边时间戳异常时保留默认 updated（当前时间）兜底
                }
            }
        } catch (_e) {
            result.path = [];
        }
    }
    // 预热失败（Card 源上游 403/WAF/网络错误）时不再为每个 type 重复预热同一 pair：
    // 各 type 降级为 false 保持响应形状不变，避免单次 type=all 请求对该 pair 发起多次网络抓取。
    // from===to 自换算不需要汇率条目（convert 直接返回 amount），保留原行为。
    // BFS 可达（hasPath）时即使无直连 rate 也尝试按路径折算三价。
    result.cash = false;
    result.remit = false;
    result.middle = false;
    if (rate !== undefined || from === to || hasPath) {
        for (const type of ['cash', 'remit', 'middle']) {
            try {
                result[type] = await getConvert(
                    from,
                    to,
                    type,
                    fxManager,
                    request,
                );
            } catch (_e) {
                result[type] = false;
            }
        }
    }
    return result;
};
