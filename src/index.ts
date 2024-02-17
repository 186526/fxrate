import process from 'node:process';
import http from 'node:http';

import rootRouter, { handler } from 'handlers.js';
import packageJson from '../package.json';

import getBOCFXRatesFromBOC from './FXGetter/boc';
import getICBCFXRates from './FXGetter/icbc';
import getCIBFXRates, { getCIBHuanyuFXRates } from './FXGetter/cib';
import getCCBFXRates from './FXGetter/ccb';

import fxmManager from './fxmManager';
import getABCFXRates from './FXGetter/abc';

const App = new rootRouter();

const Manager = new fxmManager({
    boc: getBOCFXRatesFromBOC,
    icbc: getICBCFXRates,
    cib: getCIBFXRates,
    cibHuanyu: getCIBHuanyuFXRates,
    ccb: getCCBFXRates,
    abc: getABCFXRates,
});

(async () => {
    App.use([Manager], '/(.*)');

    App.useMappingAdapter();
    if (process.env.VERCEL != '1')
        App.listen(Number(process?.env?.PORT) || 8080);

    console.log(
        `[${new Date().toUTCString()}] Server is started at ${Number(process?.env?.PORT) || 8080}.`,
    );

    App.binding(
        '/(.*)',
        new handler('ANY', [
            async (request, response) => {
                setTimeout(
                    () =>
                        console.log(
                            `[${new Date().toUTCString()}] ${request.ip} ${request.method} ${request.originURL.href}`,
                        ),
                    0,
                );
                response.headers.set(
                    'X-Powered-By',
                    `${packageJson.name}/${packageJson.version} ${process.env.NODE_ENV || 'development'}`,
                );
            },
        ]),
    );
})();

export default async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const request = await App.adapater.handleRequest(req);
    const response = await App.adapater.router.respond(request);
    App.adapater.handleResponse(response, res);
};
