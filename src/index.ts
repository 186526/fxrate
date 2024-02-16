import rootRouter, { handler } from 'handlers.js';
import process from 'node:process';
import packageJson from '../package.json';

import fxmToHandler from './fxmToHandler';

import getBOCFXRatesFromBOC from './FXGetter/boc';
import getICBCFXRates from './FXGetter/icbc';
import getCIBFXRates, { getCIBHuanyuFXRates } from './FXGetter/cib';

import fxManager from './fxManager';

const App = new rootRouter();

await Promise.all(
    [
        { boc: getBOCFXRatesFromBOC },
        { icbc: getICBCFXRates },
        { cib: getCIBFXRates },
        { cibHuanyu: getCIBHuanyuFXRates },
    ].map(async (p) => {
        console.log(
            `[${new Date().toUTCString()}] ${Object.keys(p)[0]} FX Rate is refreshing...`,
        );
        const thisFXManager = new fxManager(
            await Object.values(p)[0]().then((q) => {
                console.log(
                    `[${new Date().toUTCString()}] ${Object.keys(p)[0]} FX Rate is ready.`,
                );
                return q;
            }),
        );
        fxmToHandler(thisFXManager, App.route(`/${Object.keys(p)[0]}/(.*)`));
    }),
);

App.binding(
    '/',
    App.create('GET', async () => '200 OK'),
);

App.useMappingAdapter().listen(Number(process?.env?.PORT) || 8080);

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
                        `[${new Date().toUTCString()}] ${request.ip} ${request.method} ${request.url}`,
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

export default App;
