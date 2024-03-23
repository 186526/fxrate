/* eslint-disable @typescript-eslint/indent */
/* eslint-disable indent */

import { router, response, request, handler } from 'handlers.js';
import fxManager from './fxm/fxManager';
import { FXRate, currency } from './types';

import { round } from 'mathjs';

import packageJson from '../package.json';
import process from 'node:process';

const useBasic = (response: response<any>): void => {
    response.status = 200;
    response.headers.set('Date', new Date().toUTCString());
};

const sortObject = (obj: unknown): any => {
    if (obj instanceof Array) {
        return obj.sort();
    }
    if (typeof obj !== 'object') {
        return obj;
    }
    const keys = Object.keys(obj).sort(),
        sortedObj = {};

    for (const key of keys) {
        sortedObj[key] = sortObject(obj[key]);
    }

    return sortedObj;
};

const useJson = (response: response<any>, request: request<any>): void => {
    useBasic(response);

    const answer = JSON.parse(response.body);
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

const getConvert = async (
    from: currency,
    to: currency,
    type: string,
    fxManager: fxManager,
    request: request<any>,
    amount: number = 100,
) => {
    let answer = await fxManager.convert(
        from,
        to,
        type as 'cash' | 'remit' | 'middle',
        Number(request.query.get('amount')) || amount || 100,
        request.query.has('reverse'),
    );
    answer =
        Number(request.query.get('precision')) !== -1
            ? round(answer, Number(request.query.get('precision')) || 5)
            : answer;
    return Number(answer.toString()) || answer.toString();
};

const getDetails = async (
    from: currency,
    to: currency,
    fxManager: fxManager,
    request: request<any>,
) => {
    const result = {
        updated: (await fxManager.getUpdatedDate(from, to)).toUTCString(),
    };
    for (const type of ['cash', 'remit', 'middle']) {
        try {
            result[type] = await getConvert(from, to, type, fxManager, request);
        } catch (e) {
            result[type] = false;
        }
    }
    return result;
};

class fxmManager extends router {
    private fxms: {
        [source: string]: fxManager;
    } = {};
    private fxmStatus: {
        [source: string]: 'ready' | 'pending';
    } = {};

    private fxRateGetter: {
        [source: string]: (fxmManager?: fxmManager) => Promise<FXRate[]>;
    } = {};

    constructor(sources: { [source: string]: () => Promise<FXRate[]> }) {
        super();
        for (const source in sources) {
            this.register(source, sources[source]);
        }

        this.binding(
            '/info',
            this.create('GET', async (request: request<any>) => {
                const rep = new response<any>('', 200);
                rep.body = JSON.stringify({
                    status: 'ok',
                    sources: Object.keys(this.fxms),
                    version: `${packageJson.name}/${packageJson.version}`,
                    apiVersion: 'v1',
                    environment: process.env.NODE_ENV || 'development',
                });
                useJson(rep, request);
                return rep;
            }),
        );
    }

    public log(str: string) {
        setTimeout(() => {
            console.log(`[${new Date().toUTCString()}] [fxmManager] ${str}`);
        }, 0);
    }

    public has(source: string): boolean {
        return this.fxms[source] !== undefined;
    }

    public async updateFXManager(source: string): Promise<void> {
        if (!this.has(source)) {
            throw new Error('Source not found');
        }
        this.log(`${source} is updating...`);
        const fxRates = await this.fxRateGetter[source](this);
        fxRates.forEach((f) => this.fxms[source].update(f));
        this.fxmStatus[source] = 'ready';
        this.log(`${source} is updated, now is ready.`);
        return;
    }

    public async requestFXManager(source: string): Promise<fxManager> {
        if (this.fxmStatus[source] === 'pending') {
            await this.updateFXManager(source);
        }
        return this.fxms[source];
    }

    public register(source: string, getter: () => Promise<FXRate[]>): void {
        this.fxms[source] = new fxManager([]);
        this.fxRateGetter[source] = getter;
        this.fxmStatus[source] = 'pending';
        this.mountFXMRouter(source);
        this.log(`Registered ${source}.`);
        setInterval(() => this.updateFXManager(source), 1000 * 60 * 30);
    }

    public registerFXM(source: string, fxManager: fxManager): void {
        this.fxms[source] = fxManager;
        this.fxmStatus[source] = 'ready';
        this.mountFXMRouter(source);
        this.log(`Registered ${source}.`);
    }

    private mountFXMRouter(source: string): void {
        this.use([this.getFXMRouter(source)], `/${source}/(.*)`);
        this.use([this.getFXMRouter(source)], `/${source}`);
    }

    private getFXMRouter(source: string): router {
        const fxmRouter = new router();

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
            throw response;
        };

        const handlerCurrencyAllFXRates = async (
            request: request<any>,
            response: response<any>,
        ) => {
            const { from } = request.params;
            const result: {
                [to in keyof currency]: {
                    [type in string]: string;
                };
            } = {} as any;
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
            return response;
        };

        const handlerCurrencyConvert = async (
            request: request<any>,
            response: response<any>,
        ) => {
            const { from, to } = request.params;
            const result = await getDetails(
                from as unknown as currency,
                to as unknown as currency,
                await this.requestFXManager(source),
                request,
            );
            response.body = JSON.stringify(result);
            useJson(response, request);
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
            return response;
        };

        const handlerCurrencyConvertAmount = async (
            request: request<any>,
            response: response<any>,
        ) => {
            const { from, to, type, amount } = request.params;
            const result = await getConvert(
                from as unknown as currency,
                to as unknown as currency,
                type,
                await this.requestFXManager(source),
                request,
                Number(amount),
            );
            response.body = result.toString();
            useBasic(response);
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
}

export default fxmManager;
