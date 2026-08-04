import { router, response, request, handler, interfaces } from 'handlers.js';
import fxManager, { FXRateType } from './fxm/fxManager';
import { FXRate, JSONRPCMethods, currency } from './types';
import {
    loadSnapshot,
    saveSnapshot,
    latestUpdatedAt,
    staleRateAgeMs,
    type SnapshotData,
} from './persistence';
import {
    RefreshScheduler,
    type RefreshSchedulerConfig,
} from './refreshScheduler';

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

/** 关键数据源集合（readiness 判定「缺失」用）：大陆大行牌价 + 央行/交易中心基准 +
 * 卡组织（unionpay）构成服务核心价值；港行/外资行/第三方缺失只影响覆盖面，不阻断就绪。
 * mastercard/visa 是**按需惰性加载**的 WAF 源（首访预热可能 403/慢，冷启动无数据），
 * 不在默认关键列表——否则冷启动/无请求预热时就绪探针会永久 503。若部署方希望它们
 * 参与就绪门禁，可传自定义关键列表给 readiness()（届时按 hasUsableData 契约判定）。 */
export const CRITICAL_SOURCES = [
    'boc',
    'icbc',
    'ccb',
    'abc',
    'bocom',
    'cmb',
    'psbc',
    'pboc',
    'cfets',
    'unionpay',
] as const;

export interface ReadinessReport {
    /** 是否完全就绪：无降级源、关键源无缺失、关键源均已加载有效数据 */
    ready: boolean;
    /** 数据已降级（快照恢复过期 / 刷新失败，Cache-Control max-age=0）的源 */
    degraded: string[];
    /** 缺失的关键源（未注册 / 未初始化） */
    missing: string[];
    /** 已注册但尚未加载有效数据（pending，未完成首次刷新/快照恢复）的关键源 */
    pending: string[];
    /** 本次判定使用的关键源列表 */
    criticalSources: string[];
}

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
        [source: string]: { timeout?: NodeJS.Timeout; refreshDate: Date };
    } = {};

    // 快照恢复时按实际数据新鲜度标记的降级源集合（见 restoreSnapshot）：
    // 降级源的 Cache-Control 恒为 max-age=0，绝不对外声称新鲜；成功刷新后自动解除。
    private degradedSources = new Set<string>();

    // Phase 2 全局刷新调度器：稳定抖动 + 有界并发 + 失败退避（见 refreshScheduler.ts）。
    public readonly refreshScheduler: RefreshScheduler;

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

    constructor(
        sources: { [source: string]: () => Promise<FXRate[]> },
        options: { scheduler?: RefreshSchedulerConfig } = {},
    ) {
        super();

        this.refreshScheduler = new RefreshScheduler({
            refreshFn: (source: string) => this.updateFXManager(source),
            onSchedule: (source: string, timer: NodeJS.Timeout) => {
                const entry = this.intervalIDs[source];
                if (entry) entry.timeout = timer;
            },
            logger: (message: string) => this.log(message),
            ...options.scheduler,
        });

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
                // Phase 6 readiness 门禁：任何降级源或关键源缺失时不再报告 ok——
                // 返回 503 + status=degraded（详见 readiness()），供监控/负载均衡探针使用。
                // 注意 503 不影响 JSON-RPC instanceInfo（useInternalRestAPI 只看 body 不看状态码）。
                const report = this.readiness();
                const rep = new response<any>('', report.ready ? 200 : 503);
                rep.body = JSON.stringify({
                    status: report.ready ? 'ok' : 'degraded',
                    ready: report.ready,
                    degraded: report.degraded,
                    missing: report.missing,
                    pending: report.pending,
                    sources: Object.keys(this.fxms),
                    version: `fxrate@${globalThis.GITBUILD || 'git'} ${globalThis.BUILDTIME || 'devlopment'}`,
                    apiVersion: 'v1',
                    environment: process.env.NODE_ENV || 'development',
                });
                useJson(rep, request);
                // useBasic（useJson 内部）会把 status 强制回 200，且就绪探针响应
                // 不可缓存（CDN/反向代理缓存 503 会掩盖故障恢复）——两处都放在 useJson 之后。
                if (!report.ready) rep.status = 503;
                rep.headers.set('Cache-Control', 'no-store');
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
                // 空结果视为刷新失败：数据没有更新却把 refreshDate 推到 now 等于伪造新鲜度。
                // 走 catch → 记录退避，已 ready 的源继续服务旧数据。
                if (!fxRates || fxRates.length === 0) {
                    throw new Error(`${source} getter returned no rates`);
                }
                fxRates.forEach((f) => this.fxms[source].update(f));
                this.fxmStatus[source] = 'ready';
                this.intervalIDs[source].refreshDate = new Date();
                this.refreshScheduler.recordSuccess(source);
                this.unmarkDegraded(source);
                this.log(`${source} is updated, now is ready.`);
            } catch (error) {
                // 刷新失败记录退避（请求路径不再每次全量重抓）。
                // 已 ready 的源保持 ready 继续服务旧数据（否则单次刷新失败会让
                // 下一个请求重新触发懒加载），但标记 degraded——Cache-Control 降为
                // max-age=0、readiness 不再 ok，直到后续一次成功刷新 unmarkDegraded。
                // 只有从未成功加载过的源回到 pending（从未服务过数据，无降级语义）。
                if (this.fxmStatus[source] === 'ready') {
                    this.markDegraded(source);
                } else {
                    this.fxmStatus[source] = 'pending';
                }
                this.refreshScheduler.recordFailure(source, error);
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
            // 惰性 FXM 源（mastercard/visa）没有注册 getter：不在这里触发 updateFXManager
            // （fxRateGetter 为 undefined），它的预热由请求路径经覆写的 async
            // getfxRateList 自行完成（registerFXM 已包装它在成功后置 ready）。
            if (!this.fxRateGetter[source]) {
                return this.fxms[source];
            }
            // 刷新失败后处于退避期：不再每次请求都触发全量重抓，直接返回当前（空）实例，
            // 由定时器在退避窗口结束后再重试。
            if (this.refreshScheduler.blocked(source) !== undefined) {
                this.log(`${source} in backoff, serving current state`);
                return this.fxms[source];
            }
            // 懒加载抓取可能很慢（Visa 等上游 10s+ 超时）。
            // 5s 内没就绪则快速失败返回空实例，避免拖住整个 batch / 首屏 SSR。
            const p =
                this.pendingPromises[source] ?? this.updateFXManager(source);
            let timeout: NodeJS.Timeout | undefined;
            try {
                await Promise.race([
                    p,
                    new Promise((_, reject) => {
                        timeout = setTimeout(
                            () => reject(new Error(`${source} load timeout`)),
                            5000,
                        );
                    }),
                ]);
            } catch {
                this.log(`${source} load timed out, serving empty`);
            } finally {
                // 竞态已 settle 即取消超时定时器，避免每次懒加载都残留一个 5s
                // 空转定时器（全量测试下产生 open handle / 事件循环噪音）。
                if (timeout) clearTimeout(timeout);
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

        // 刷新定时器统一交给 RefreshScheduler：稳定相位抖动 + 全局有界并发 + 失败退避。
        // intervalIDs 保留 refreshDate（Cache-Control 用）与当前定时器句柄（可观测）。
        this.intervalIDs[source] = {
            refreshDate: refreshDate,
        };
        this.refreshScheduler.register(source);
    }

    public registerFXM(source: string, fxManager: fxManager): void {
        this.fxms[source] = fxManager;
        // 惰性 FXM 源（mastercard/visa）注册时通常还没预热任何数据：初始状态按
        // hasUsableData 判定——预加载实例（构造时已带数据）直接 ready，空 lazy 源
        // 保持 pending（readiness 不会把无数据的卡源误判为已就绪）。
        this.fxmStatus[source] = fxManager.hasUsableData()
            ? 'ready'
            : 'pending';
        // 首次 getfxRateList 成功预热后置 ready：把原型方法包一层（绑定原方法防递归），
        // 成功返回（网络拉取写缓存）才算「已加载可用数据」。
        const originalGetfxRateList = fxManager.getfxRateList.bind(fxManager);
        fxManager.getfxRateList = async (from, to) => {
            const rate = await originalGetfxRateList(from, to);
            if (this.fxmStatus[source] !== 'ready') {
                this.fxmStatus[source] = 'ready';
                this.log(`${source} warmed up, now is ready.`);
            }
            return rate;
        };
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
            const secs = this.refreshScheduler.intervalSecs;
            // 降级源（恢复时数据已过期）绝不发新鲜 Cache-Control：恒为 max-age=0，
            // 直到一次成功刷新把它解除降级。
            const ageSecs = this.isDegraded(source)
                ? 0
                : secs -
                  Math.round(
                      Math.abs(
                          ((
                              this.intervalIDs[source] ?? {
                                  refreshDate: new Date(),
                              }
                          ).refreshDate.getTime() -
                              new Date().getTime()) /
                              1000,
                      ) % secs,
                  );
            response.headers.set('Cache-Control', `public, max-age=${ageSecs}`);
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

    public async stopAllInterval(): Promise<void> {
        // 停机契约：先停掉调度器（取消全部定时器 + 关闭执行器，不再接任何新刷新，
        // 排队任务以 closed 拒绝），随后等待所有在途刷新 settle（refreshScheduler.drain
        // 覆盖经调度器启动的刷新；pendingPromises 兜底请求路径直接启动的懒加载），
        // 最后才落盘快照——否则在途刷新刚写回的新数据会被漏掉（「不能漏最后刷新」）。
        this.refreshScheduler.stop();
        await Promise.allSettled([
            this.refreshScheduler.drain(),
            ...Object.values(this.pendingPromises).filter(
                (p): p is Promise<void> => p !== undefined,
            ),
        ]);
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

    // 加载快照：恢复内存汇率表并标记 ready（跳过懒加载抓取）。
    // 按实际数据新鲜度标记降级：某源最新一条汇率的 updated 早于 now - 阈值 → degraded
    // （Cache-Control max-age=0，refreshDate 如实指向最后数据时间，不伪装新鲜）；
    // 30 分钟定时刷新仍按 updated 时间戳守卫覆盖旧数据，成功后自动解除降级。
    public restoreSnapshot(
        snapshot: SnapshotData,
        options: { staleRateAgeMs?: number; now?: number } = {},
    ): void {
        const staleAgeMs = options.staleRateAgeMs ?? staleRateAgeMs();
        const now = options.now ?? Date.now();
        for (const source in snapshot) {
            const fxm = this.fxms[source];
            if (!fxm?.restore) continue;
            fxm.restore(snapshot[source] as never);
            if (source in this.fxmStatus) this.fxmStatus[source] = 'ready';
            const latest = latestUpdatedAt(snapshot[source]);
            const degraded =
                latest === null || now - latest.getTime() > staleAgeMs;
            if (this.intervalIDs[source]) {
                this.intervalIDs[source].refreshDate =
                    degraded && latest ? latest : new Date();
            }
            if (degraded) this.markDegraded(source);
            this.log(
                `[persistence] restored ${source} from cache${degraded ? ' (degraded)' : ''}`,
            );
        }
    }

    // —— 降级/状态观测（供测试与运维断言）——

    public isDegraded(source: string): boolean {
        return this.degradedSources.has(source);
    }

    public getDegradedSources(): string[] {
        return [...this.degradedSources];
    }

    public getStatus(source: string): 'ready' | 'pending' {
        return this.fxmStatus[source];
    }

    // —— Phase 6 readiness 就绪门禁 ——

    public readiness(
        criticalSources: readonly string[] = CRITICAL_SOURCES,
    ): ReadinessReport {
        const degraded = this.getDegradedSources();
        const missing = criticalSources.filter((source) => !this.has(source));
        // 已注册但尚未加载有效数据的关键源不算就绪：
        // ① status 非 ready（未完成首次刷新/快照恢复）——仅检查注册（has）会让
        //    冷启动未拉数阶段被探针误判 ok；
        // ② status ready 但实例没有可用数据（hasUsableData 同步契约，如惰性 FXM
        //    尚未预热缓存）同样视为 pending。
        const pending = criticalSources.filter((source) => {
            if (!this.has(source)) return false;
            if (this.getStatus(source) !== 'ready') return true;
            const fxm = this.fxms[source];
            return typeof fxm.hasUsableData === 'function'
                ? !fxm.hasUsableData()
                : false;
        });
        return {
            ready:
                degraded.length === 0 &&
                missing.length === 0 &&
                pending.length === 0,
            degraded,
            missing,
            pending,
            criticalSources: [...criticalSources],
        };
    }

    private markDegraded(source: string): void {
        this.degradedSources.add(source);
    }

    private unmarkDegraded(source: string): void {
        this.degradedSources.delete(source);
    }
}

export default fxmManager;
