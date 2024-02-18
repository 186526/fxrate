import process from 'node:process';
import http from 'node:http';

import rootRouter, { handler } from 'handlers.js';
import packageJson from '../package.json';

import fxmManager from './fxmManager';

import getBOCFXRatesFromBOC from './FXGetter/boc';
import getICBCFXRates from './FXGetter/icbc';
import getCIBFXRates, { getCIBHuanyuFXRates } from './FXGetter/cib';
import getCCBFXRates from './FXGetter/ccb';
import getABCFXRates from './FXGetter/abc';
import getBOCOMFXRates from './FXGetter/bocom';
import getPSBCFXRates from './FXGetter/psbc';
import getCMBFXRates from './FXGetter/cmb';

const App = new rootRouter();

const Manager = new fxmManager({
    boc: getBOCFXRatesFromBOC,
    icbc: getICBCFXRates,
    cib: getCIBFXRates,
    cibHuanyu: getCIBHuanyuFXRates,
    ccb: getCCBFXRates,
    abc: getABCFXRates,
    bocom: getBOCOMFXRates,
    psbc: getPSBCFXRates,
    cmb: getCMBFXRates,
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
        '/',
        App.create('ANY', async () => '200 OK\n\n/info - Instance Info\n'),
    );

    App.binding(
        '/(.*)',
        new handler('ANY', [
            async (request, response) => {
                setTimeout(
                    () =>
                        console.log(
                            `[${new Date().toUTCString()}] ${request.ip} ${request.method} ${request.url}`,
                        ),
                    0,
                );
                response.headers.set('X-Powered-By', packageJson.name);
                response.headers.set('X-Author', packageJson.author);
                response.headers.set('X-License', packageJson.license);
            },
        ]),
    );
})();

export default async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const request = await App.adapater.handleRequest(req);
    const response = await App.adapater.router.respond(request);
    App.adapater.handleResponse(response, res);
};
