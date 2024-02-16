/* eslint-disable @typescript-eslint/indent */
/* eslint-disable indent */
import { router, response } from 'handlers.js';
import FXRateManager from './fxManager';
import { currency } from './types';
import { round } from 'mathjs';

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
        router.create('GET', async (request) => {
            const { from } = request.params;
            const result: {
                [to in keyof currency]: {
                    [type in 'cash' | 'remit' | 'middle']: string;
                };
            } = {} as any;
            for (const to in fxManager.fxRateList[from]) {
                if (to == from) continue;
                result[to] = {};
                for (const type in fxManager.fxRateList[from][to]) {
                    result[to][type] = fxManager.convert(
                        from as unknown as currency.unknown,
                        to as unknown as currency.unknown,
                        type as 'cash' | 'remit' | 'middle',
                        Number(request.query.get('amount')) || 100,
                        request.query.has('reverse'),
                    );
                    result[to][type] =
                        Number(request.query.get('precision')) !== -1
                            ? round(
                                  result[to][type],
                                  Number(request.query.get('precision')) || 2,
                              )
                            : result[to][type];
                    result[to][type] = result[to][type].toString();
                }
            }
            return result;
        }),
    );

    router.binding(
        '/:from/:to',
        router.create('GET', async (request) => {
            const { from, to } = request.params;
            const result = {};
            for (const type in fxManager.fxRateList[from][to]) {
                result[type] = fxManager.convert(
                    from as unknown as currency.unknown,
                    to as unknown as currency.unknown,
                    type as 'cash' | 'remit' | 'middle',
                    Number(request.query.get('amount')) || 100,
                    request.query.has('reverse'),
                );
                result[type] =
                    Number(request.query.get('precision')) !== -1
                        ? round(
                              result[type],
                              Number(request.query.get('precision')) || 2,
                          )
                        : result[type];
                result[type] = result[type].toString();
            }
            return result;
        }),
    );

    router.binding(
        '/:from/:to/:type/:amount',
        router.create('GET', async (request) => {
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
                    ? round(fxRate, Number(request.query.get('precision')) || 2)
                    : fxRate;
            return fxRate.toString();
        }),
    );
};
