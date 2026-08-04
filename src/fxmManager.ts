import { router, response, request, handler, interfaces } from 'handlers.js';
import fxManager, { FXRateType } from './fxm/fxManager';
import { FXRate, JSONRPCMethods, currency } from './types';
import { loadSnapshot, saveSnapshot } from './persistence';

import process from 'node:process';

import JSONRPCRouter from 'handlers.js-jsonrpc';

import {
    useBasic,
    useJson,
    getConvert,
    getDetails,
    bodyToString,
} from './handler/rest';
import {
    countExpensiveCardItems,
    RPC_BATCH_TOO_LARGE,
    RPC_EXPENSIVE_CARD_LIMIT,
    RPC_MAX_BATCH_SIZE,
    RPC_MAX_EXPENSIVE_CARD_ITEMS,
    type RPCBudgetError,
} from './handler/limits';

export const useInternalRestAPI = async (url: string, router: router) => {
    const restResponse = await router
        .respond(
            new request(
                'GET',
                new URL(`http://this.internal/${url}`),
                new interfaces.headers({}),
                '',
                {},
            ),
        )
        .catch((e: unknown) => e);

    if (restResponse instanceof Error) throw restResponse;
    if (!(restResponse instanceof response)) {
        throw new Error(
            `Internal REST API returned an invalid response: ${String(restResponse)}`,
        );
    }

    try {
        return JSON.parse(bodyToString(restResponse.body));
    } catch (_e) {
        return restResponse;
    }
};

class fxmManager extends JSONRPCRouter<any, any, JSONRPCMethods> {
    private fxms: {
        [source: string]: fxManager;
    } = {};

    private fxmStatus: {
        [source: string]: 'ready' | 'pending';
    } = {};

    private pendingPromises: {
        [source: string]: Promise<void> | undefined;
    } = {};

    private fxRateGetter: {
        [source: string]: (fxmManager?: fxmManager) => Promise<FXRate[]>;
    } = {};

    public intervalIDs: {
        [source: string]: { timeout: NodeJS.Timeout; refreshDate: Date };
    } = {};

    protected rpcHandlers = {
        instanceInfo: () => useInternalRestAPI('info', this),

        listCurrencies: ({ source }: { source: string }) => {
            if (!source) throw new Error('source is required.');

            return useInternalRestAPI(`${source}/`, this).then(
                (k) =>
                    new Object({
                        currency: k.currency,
                        date: k.date,
                    }),
            );
        },

        listFXRates: ({
            source,
            from,
            precision = 2,
            amount = 100,
            fees = 0,
            reverse = false,
            bfs = false,
        }: {
            source: string;
            from: string;
            precision?: number;
            amount?: number;
            fees?: number;
            reverse?: boolean;
            bfs?: boolean;
        }) => {
            if (!source) throw new Error('source is required.');
            if (!from) throw new Error('from is required.');

            return useInternalRestAPI(
                `${source}/${from}?precision=${precision}&amount=${amount}&fees=${fees}${reverse ? '&reverse' : ''}${bfs ? '&bfs=1' : ''}`,
                this,
            );
        },

        getFXRate: ({
            source,
            from,
            to,
            type,
            precision = 2,
            amount = 100,
            fees = 0,
            reverse = false,
            bfs = false,
        }: {
            source: string;
            from: string;
            to: string;
            type: string;
            precision?: number;
            amount?: number;
            fees?: number;
            reverse?: boolean;
            bfs?: boolean;
        }) => {
            if (!source) throw new Error('source is required.');
            if (!from) throw new Error('from is required.');
            if (!to) throw new Error('to is required.');
            if (!type) throw new Error('type is required.');
            if (type == 'all') type = '';

            return useInternalRestAPI(
                `${source}/${from}/${to}/${type}?precision=${precision}&fees=${fees}${reverse ? '&reverse' : ''}&amount=${amount}${bfs ? '&bfs=1' : ''}`,
                this,
            );
        },
    };

    constructor(sources: { [source: string]: () => Promise<FXRate[]> }) {
        super();
        for (const source in sources) {
            this.registerGetter(source, sources[source]);
        }

        // Phase 1 RPC 入口硬预算：在 JSON-RPC v2 逐条 dispatch 之前做「静态结构」校验
        // （批量条数 + 昂贵卡组织条目数），超限返回稳定 JSON-RPC 错误（HTTP 200），
        // 不触发任何 RPC handler / 内部 REST / 数据抓取。捕获基类 responder 再包一层。
        const baseV2RPCresponder = this.v2RPCresponder;
        this.v2RPCresponder = async (
            rpcRequest: request<any>,
            rpcResponse?: response<any>,
        ): Promise<response<any>> => {
            if (!rpcResponse) rpcResponse = new response<any>('');
            const budgetError = this.rpcBudgetViolation(
                rpcRequest.query.get('content') ?? rpcRequest.body,
            );
            if (budgetError) {
                rpcResponse.status = 200;
                rpcResponse.headers.set(
                    'Content-Type',
                    'application/json; charset=utf-8',
                );
                rpcResponse.body = JSON.stringify({
                    jsonrpc: '2.0',
                    id: null,
                    error: budgetError,
                });
                return rpcResponse;
            }
            const dispatched = await baseV2RPCresponder.call(
                this,
                rpcRequest,
                rpcResponse,
                () => undefined,
            );
            return dispatched instanceof response ? dispatched : rpcResponse;
        };

        this.binding(
            '/info',
            this.create('GET', async (request: request<any>) => {
                const rep = new response<any>('', 200);
                rep.body = JSON.stringify({
                    status: 'ok',
                    sources: Object.keys(this.fxms),
                    version: `fxrate@${globalThis.GITBUILD || 'git'} ${globalThis.BUILDTIME || 'devlopment'}`,
                    apiVersion: 'v1',
                    environment: process.env.NODE_ENV || 'development',
                });
                useJson(rep, request);
                return rep;
            }),
        );

        this.enableList().mount();
        this.log('JSONRPC is mounted.');

        // 冷启动：加载磁盘快照跳过上游全量抓取（Visa 等慢源首访 30s+）
        const snapshot = loadSnapshot();
        if (snapshot) {
            this.restoreSnapshot(snapshot as never);
        }
    }

    public log(str: string) {
        if (process.env.LOG_LEVEL === 'error') return;
        setTimeout(() => {
            console.log(`[${new Date().toUTCString()}] [fxmManager] ${str}`);
        }, 0);
    }

    // JSON-RPC v2 预算校验（Phase 1）：仅做静态结构检查，超限返回错误对象、合法返回 null。
    // 非 JSON body 不在此拦截，交给下游 responder 输出 -32700 Parse error。
    private rpcBudgetViolation(receivedJSONRPC: string): RPCBudgetError | null {
        let parsed: unknown;
        try {
            parsed = JSON.parse(receivedJSONRPC);
        } catch {
            return null;
        }
        if (Array.isArray(parsed)) {
            if (parsed.length > RPC_MAX_BATCH_SIZE) return RPC_BATCH_TOO_LARGE;
            if (
                countExpensiveCardItems(parsed) > RPC_MAX_EXPENSIVE_CARD_ITEMS
            ) {
                return RPC_EXPENSIVE_CARD_LIMIT;
            }
        } else if (parsed !== null && typeof parsed === 'object') {
            if (
                countExpensiveCardItems([parsed]) > RPC_MAX_EXPENSIVE_CARD_ITEMS
            ) {
                return RPC_EXPENSIVE_CARD_LIMIT;
            }
        }
        return null;
    }

    public has(source: string): boolean {
        return this.fxms[source] !== undefined;
    }

    public async updateFXManager(source: string): Promise<void> {
        const currentPromise = this.pendingPromises[source];
        if (currentPromise) return currentPromise;

        const pendingPromise = (async () => {
            try {
                if (!this.has(source)) {
                    throw new Error('Source not found');
                }
                this.log(`${source} is updating...`);
                const fxRates = await this.fxRateGetter[source](this);
                fxRates.forEach((f) => this.fxms[source].update(f));
                this.fxmStatus[source] = 'ready';
                this.intervalIDs[source].refreshDate = new Date();
                this.log(`${source} is updated, now is ready.`);
            } catch (error) {
                this.fxmStatus[source] = 'pending';
                this.log(
                    `${source} update failed: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
                throw error;
            }
        })();

        this.pendingPromises[source] = pendingPromise;
        try {
            await pendingPromise;
        } finally {
            if (this.pendingPromises[source] === pendingPromise) {
                delete this.pendingPromises[source];
            }
        }
    }

    public async requestFXManager(source: string): Promise<fxManager> {
        if (this.fxmStatus[source] === 'pending') {
            // 懒加载抓取可能很慢（Visa 等上游 10s+ 超时）。
            // 5s 内没就绪则快速失败返回空实例，避免拖住整个 batch / 首屏 SSR。
            const p =
                this.pendingPromises[source] ?? this.updateFXManager(source);
            try {
                await Promise.race([
                    p,
                    new Promise((_, reject) =>
                        setTimeout(
                            () => reject(new Error(`${source} load timeout`)),
                            5000,
                        ),
                    ),
                ]);
            } catch {
                this.log(`${source} load timed out, serving empty`);
            }
        }
        return this.fxms[source];
    }

    public registerGetter(
        source: string,
        getter: () => Promise<FXRate[]>,
    ): void {
        this.fxms[source] = new fxManager([]);
        this.fxRateGetter[source] = getter;
        this.fxmStatus[source] = 'pending';
        this.mountFXMRouter(source);
        this.log(`Registered ${source}.`);

        const refreshDate = new Date();

        this.intervalIDs[source] = {
            timeout: setInterval(
                () => this.updateFXManager(source).catch(() => undefined),
                1000 * 60 * 30,
            ),
            refreshDate: refreshDate,
        };
    }

    public registerFXM(source: string, fxManager: fxManager): void {
        this.fxms[source] = fxManager;
        this.fxmStatus[source] = 'ready';
        this.mountFXMRouter(source);
        this.log(`Registered ${source}.`);
    }

    private mountFXMRouter(source: string): void {
        // handlers.js 0.1.6 的 use() 要求路径含未命名捕获组（用于转发子路径），
        // 且空子路径（`/${source}` 精确访问）时 params['0'] 为空字符串、子路由不会自动匹配，
        // 因此单独绑定精确路径并显式重写 pathname 后转发到子路由的 '/'。
        this.use([this.getFXMRouter(source)], `/${source}/(.*)`);
        this.binding(
            `/${source}`,
            new handler('ANY', [
                async (req: request<any>, res: response<any>) => {
                    req.url.pathname = '/';
                    delete req.params['0'];
                    return this.getFXMRouter(source).respond(
                        req,
                        res ?? new response(''),
                    );
                },
            ]),
        );
    }

    private getFXMRouter(source: string): router {
        const fxmRouter = new router();

        const useCache = (response: response<any>) => {
            response.headers.set(
                'Cache-Control',
                `public, max-age=${
                    30 * 60 -
                    Math.round(
                        Math.abs(
                            ((
                                this.intervalIDs[source] ?? {
                                    refreshDate: new Date(),
                                }
                            ).refreshDate.getTime() -
                                new Date().getTime()) /
                                1000,
                        ) % 1800,
                    )
                }`,
            );
        };

        const handlerSourceInfo = async (
            request: request<any>,
            response: response<any>,
        ) => {
            if (request.params[0] && request.params[0] != source) {
                return response;
            }
            response.body = JSON.stringify({
                status: 'ok',
                source,
                currency: Object.keys(
                    (await this.requestFXManager(source)).fxRateList,
                ).sort(),
                date: new Date().toUTCString(),
            });
            useJson(response, request);
            useCache(response);
            throw response;
        };

        const handlerCurrencyAllFXRates = async (
            request: request<any>,
            response: response<any>,
        ) => {
            if (request.params.from)
                request.params.from = request.params.from.toUpperCase();

            const { from } = request.params as { from: string };

            const result: {
                [to: string]:
                    | string
                    | {
                          [type: string]: string | number | boolean | string[];
                      };
            } = {};
            if (!(await this.requestFXManager(source)).ableToGetAllFXRate) {
                response.status = 403;
                result['status'] = 'error';
                result['message'] =
                    `Not able to get all FX rate with ${from} on ${source}`;
                response.body = JSON.stringify(result);
                useJson(response, request);
                return response;
            }
            for (const to in (await this.requestFXManager(source)).fxRateList[
                from
            ]) {
                if (to == from) continue;
                result[to] = await getDetails(
                    from as unknown as currency,
                    to as unknown as currency,
                    await this.requestFXManager(source),
                    request,
                );
            }
            response.body = JSON.stringify(result);
            useJson(response, request);
            useCache(response);
            return response;
        };

        const handlerCurrencyConvert = async (
            request: request<any>,
            response: response<any>,
        ) => {
            if (request.params.from)
                request.params.from = request.params.from.toUpperCase();

            if (request.params.to)
                request.params.to = request.params.to.toUpperCase();

            const { from, to } = request.params;
            const result = await getDetails(
                from as unknown as currency,
                to as unknown as currency,
                await this.requestFXManager(source),
                request,
            );
            // BFS 命中 CNY/CNH 别名（如图里只有 CNH 而目标为 CNY）时提示调用方，
            // 前端可据此显示「经 CNH 折算」；未命中别名则不设置该头。
            if (typeof result.alias === 'string') {
                response.headers.set('X-FXRate-Alias', result.alias);
            }
            response.body = JSON.stringify(result);
            useJson(response, request);
            // Date 头复用 getDetails 已计算的 updated（UTC 字符串），
            // 不再对同一 pair 二次 getUpdatedDate——避免 Card 源预热失败时重复网络抓取。
            response.headers.set(
                'Date',
                typeof result.updated === 'string'
                    ? result.updated
                    : new Date().toUTCString(),
            );
            useCache(response);

            return response;
        };

        const handlerCurrencyConvertAmount = async (
            request: request<any>,
            response: response<any>,
        ) => {
            if (request.params.from)
                request.params.from = request.params.from.toUpperCase();

            if (request.params.to)
                request.params.to = request.params.to.toUpperCase();

            const { from, to, type, amount } = request.params;
            let result: string | number | boolean;
            try {
                result = await getConvert(
                    from as unknown as currency,
                    to as unknown as currency,
                    type!,
                    await this.requestFXManager(source),
                    request,
                    Number(amount),
                );
            } catch (_e) {
                // 源不可用（如上游 403/WAF）时降级返回 false，避免整个请求 500。
                result = false;
            }
            response.body = result.toString();
            useBasic(response);
            // 仅当换算成功（缓存已预热）才读 updated 设置 Date 头：
            // 失败时跳过 getUpdatedDate，避免对同一 pair 再次网络预热（Card 源 403/WAF 时重复抓取）。
            if (result !== false) {
                try {
                    response.headers.set(
                        'Date',
                        (
                            await (
                                await this.requestFXManager(source)
                            ).getUpdatedDate(
                                from as unknown as currency.unknown,
                                to as unknown as currency.unknown,
                            )
                        ).toUTCString(),
                    );
                } catch (_e) {
                    // 源不可用（如上游 403/WAF）时 Date 头回落为当前时间，避免整个请求 500。
                    response.headers.set('Date', new Date().toUTCString());
                }
            }
            useCache(response);

            return response;
        };

        fxmRouter.binding('/', new handler('GET', [handlerSourceInfo]));

        fxmRouter.binding(
            '/:from',
            new handler('GET', [handlerSourceInfo, handlerCurrencyAllFXRates]),
        );

        fxmRouter.binding(
            '/:from/:to',
            new handler('GET', [handlerCurrencyConvert]),
        );

        fxmRouter.binding(
            '/:from/:to/:type',
            new handler('GET', [handlerCurrencyConvertAmount]),
        );

        fxmRouter.binding(
            '/:from/:to/:type/:amount',
            new handler('GET', [handlerCurrencyConvertAmount]),
        );

        return fxmRouter;
    }

    public stopAllInterval(): void {
        for (const id in this.intervalIDs) {
            clearInterval(this.intervalIDs[id].timeout);
        }
        // 停机前落盘汇率快照，冷启动直接加载跳过上游抓取
        try {
            saveSnapshot(this.dumpSnapshot());
        } catch {
            // 持久化失败不阻塞停机
        }
    }

    // 返回当前内存汇率快照（仅抓取型源；mastercard/visa 数据在模块级 LRU 不在此列）
    public dumpSnapshot(): {
        [source: string]: { [from: string]: { [to: string]: FXRateType } };
    } {
        const out: {
            [source: string]: { [from: string]: { [to: string]: FXRateType } };
        } = {};
        for (const source in this.fxms) {
            const snap = this.fxms[source].snapshot?.();
            if (snap && Object.keys(snap).length > 0) out[source] = snap;
        }
        return out;
    }

    // 加载快照：恢复内存汇率表并标记 ready（跳过懒加载抓取），
    // 30 分钟定时刷新仍按 updated 时间戳守卫覆盖旧数据
    public restoreSnapshot(snapshot: {
        [source: string]: { [from: string]: { [to: string]: FXRateType } };
    }): void {
        for (const source in snapshot) {
            const fxm = this.fxms[source];
            if (!fxm?.restore) continue;
            fxm.restore(snapshot[source] as never);
            if (source in this.fxmStatus) this.fxmStatus[source] = 'ready';
            if (this.intervalIDs[source])
                this.intervalIDs[source].refreshDate = new Date();
            this.log(`[persistence] restored ${source} from cache`);
        }
    }
}

export default fxmManager;
