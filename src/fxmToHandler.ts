/* eslint-disable @typescript-eslint/indent */
/* eslint-disable indent */
import { router, response, handler, request } from 'handlers.js';
import FXRateManager from './fxManager';
import { currency } from './types';
import { round } from 'mathjs';

const useBasic = (response: response<any>): void => {
    response.status = 200;
    response.headers.set('Date', new Date().toUTCString());
};

const useJson = (response: response<any>): void => {
    useBasic(response);
    response.headers.set('Content-type', 'application/json; charset=utf-8');
};

const getDetails = async (
    from: currency,
    to: currency,
    fxManager: FXRateManager,
    request: request<any>,
) => {
    const result = {
        updated: fxManager.getUpdatedDate(from, to).toUTCString(),
    };
    for (const type of ['cash', 'remit', 'middle']) {
        try {
            result[type] = fxManager.convert(
                from,
                to,
                type as 'cash' | 'remit' | 'middle',
                Number(request.query.get('amount')) || 100,
                request.query.has('reverse'),
            );
            result[type] =
                Number(request.query.get('precision')) !== -1
                    ? round(
                          result[type],
                          Number(request.query.get('precision')) || 5,
                      )
                    : result[type];
            result[type] =
                Number(result[type].toString()) || result[type].toString();
        } catch (e) {
            result[type] = false;
        }
    }
    return result;
};

export default (
    generateFXManager: () => Promise<FXRateManager>,
    router: router,
) => {
    let fxManager: FXRateManager = null as any;

    router.binding(
        '/(.*)',
        router.create('ANY', async () => {
            if (!fxManager) fxManager = await generateFXManager();
            return new response('Method Not Allowed', 405);
        }),
    );

    router.binding(
        '/',
        router.create('GET', async () => '200 OK'),
    );

    router.binding(
        '/:from',
        new handler('GET', [
            async (request, response) => {
                const { from } = request.params;
                const result: {
                    [to in keyof currency]: {
                        [type in 'cash' | 'remit' | 'middle']: string;
                    };
                } = {} as any;
                for (const to in fxManager.fxRateList[from]) {
                    if (to == from) continue;
                    result[to] = await getDetails(
                        from as unknown as currency.unknown,
                        to as unknown as currency.unknown,
                        fxManager,
                        request,
                    );
                }
                response.body = JSON.stringify(result);
                useJson(response);
                response.headers.set('Date', new Date().toUTCString());
                return response;
            },
        ]),
    );

    router.binding(
        '/:from/:to',
        new handler('GET', [
            async (request, response) => {
                const { from, to } = request.params;
                const result = await getDetails(
                    from as unknown as currency.unknown,
                    to as unknown as currency.unknown,
                    fxManager,
                    request,
                );
                response.body = JSON.stringify(result);
                useJson(response);
                response.headers.set(
                    'Date',
                    fxManager
                        .getUpdatedDate(
                            from as unknown as currency.unknown,
                            to as unknown as currency.unknown,
                        )
                        .toUTCString(),
                );
                return response;
            },
        ]),
    );

    router.binding(
        '/:from/:to/:type/:amount',
        new handler('GET', [
            async (request, response) => {
                const { from, to, type, amount } = request.params;
                let fxRate = fxManager.convert(
                    from as unknown as currency.unknown,
                    to as unknown as currency.unknown,
                    type as 'cash' | 'remit' | 'middle',
                    Number(amount) || 100,
                    request.query.has('reverse'),
                );
                fxRate =
                    Number(request.query.get('precision')) !== -1
                        ? round(
                              fxRate,
                              Number(request.query.get('precision')) || 5,
                          )
                        : fxRate;
                response.body = fxRate.toString();
                useBasic(response);
                response.headers.set(
                    'Date',
                    fxManager
                        .getUpdatedDate(
                            from as unknown as currency.unknown,
                            to as unknown as currency.unknown,
                        )
                        .toUTCString(),
                );
                return response;
            },
        ]),
    );
};
