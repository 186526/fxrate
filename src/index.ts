import process from 'node:process';
import http from 'node:http';

import rootRouter, { handler } from 'handlers.js';
import packageJson from '../package.json';

import fxmManager from './fxmManager';
import { useBasic } from './fxmManager';

import getBOCFXRatesFromBOC from './FXGetter/boc';
import getICBCFXRates from './FXGetter/icbc';
import getCIBFXRates, { getCIBHuanyuFXRates } from './FXGetter/cib';
import getCCBFXRates from './FXGetter/ccb';
import getABCFXRates from './FXGetter/abc';
import getBOCOMFXRates from './FXGetter/bocom';
import getPSBCFXRates from './FXGetter/psbc';
import getCMBFXRates from './FXGetter/cmb';
import getPBOCFXRates from './FXGetter/pboc';
import getUnionPayFXRates from './FXGetter/unionpay';
import getJCBFXRates from './FXGetter/jcb';
import getWiseFXRates from './FXGetter/wise';
import getHSBCHKFXRates from './FXGetter/hsbc.hk';
import getHSBCCNFXRates from './FXGetter/hsbc.cn';
import getHSBCAUFXRates from './FXGetter/hsbc.au';
import getCITICCNFXRates from './FXGetter/citic.cn';
import getSPDBFXRates from './FXGetter/spdb';

import mastercardFXM from './FXGetter/mastercard';
import visaFXM from './FXGetter/visa';

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
    pboc: getPBOCFXRates,
    unionpay: getUnionPayFXRates,
    jcb: getJCBFXRates,
    'hsbc.hk': getHSBCHKFXRates,
    'hsbc.cn': getHSBCCNFXRates,
    'hsbc.au': getHSBCAUFXRates,
    'citic.cn': getCITICCNFXRates,
    spdb: getSPDBFXRates,
});

Manager.registerFXM('mastercard', new mastercardFXM());
Manager.registerFXM('visa', new visaFXM());

if (process.env.ENABLE_WISE == '1') {
    if (process.env.WISE_TOKEN == undefined)
        throw new Error('WISE_TOKEN is not set.');
    Manager.registerGetter(
        'wise',
        getWiseFXRates(
            process.env.WISE_SANDBOX_API == '1',
            process.env.WISE_TOKEN,
        ),
    );
}

(async () => {
    App.binding(
        '/(.*)',
        new handler('ANY', [
            async (request, response) => {
                useBasic(response);
                response.status = 404;
            },
        ]),
    );

    App.useMappingAdapter();
    if (process.env.VERCEL != '1')
        App.listen(Number(process?.env?.PORT) || 8080);

    console.log(
        `[${new Date().toUTCString()}] Server is started at ${Number(process?.env?.PORT) || 8080} with NODE_ENV ${process.env.NODE_ENV || 'development'}.`,
    );

    App.binding(
        '/',
        App.create('ANY', async () => '200 OK\n\n/info - Instance Info\n'),
    );

    App.binding(
        '/(.*)',
        new handler('ANY', [
            async (request, response) => {
                console.log(
                    `[${new Date().toUTCString()}] ${request.ip} ${request.method} ${request.originURL}`,
                );

                response.headers.set('X-Powered-By', packageJson.name);
                response.headers.set('X-Author', packageJson.author);
                response.headers.set(
                    'X-License',
                    'MIT, Data copyright belongs to its source. More details at <https://github.com/186526/fxrate>.',
                );
            },
        ]),
    );

    App.use([Manager], '/(.*)');
    App.use([Manager], '/v1/(.*)');
})();

export default async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const request = await App.adapater.handleRequest(req);
    const response = await App.adapater.router.respond(request);
    App.adapater.handleResponse(response, res);
};
