import { router, response, request, handler, interfaces } from 'handlers.js';
import fxManager from './fxm/fxManager';
import { FXRate, JSONRPCMethods, currency } from './types';

import process from 'node:process';

import JSONRPCRouter from 'handlers.js-jsonrpc';

import {
    useBasic,
    useJson,
    getConvert,
    getDetails,
    bodyToString,
} from './handler/rest';

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

        process.once('SIGTERM', () => this.stopAllInterval());
        process.once('SIGINT', () => this.stopAllInterval());

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
    }

    public log(str: string) {
        if (process.env.LOG_LEVEL === 'error') return;
        setTimeout(() => {
            console.log(`[${new Date().toUTCString()}] [fxmManager] ${str}`);
        }, 0);
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
            await (this.pendingPromises[source] ??
                this.updateFXManager(source));
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
            try {
                response.headers.set(
                    'Date',
                    (
                        await (
                            await this.requestFXManager(source)
                        ).getUpdatedDate(
                            from as unknown as currency,
                            to as unknown as currency,
                        )
                    ).toUTCString(),
                );
            } catch (_e) {
                // 源不可用（如上游 403/WAF）时 Date 头回落为当前时间，避免整个请求 500。
                response.headers.set('Date', new Date().toUTCString());
            }
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
    }
}

export default fxmManager;
