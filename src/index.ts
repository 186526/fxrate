import process from 'node:process';
import http from 'node:http';
import dns from 'node:dns';

// 上游抓取统一走 IPv4 优先（Happy Eyeballs）：部分银行域名（如 www.bankcomm.com）
// 的 AAAA 记录优先于 A 记录，而无 IPv6 出口的集群（k8s/K3s 常见）连接 IPv6 会
// 一直超时到 axios 10s 上限——实测 bocom 上游在 pod 内解析到 IPv6 后 fetch 超时、
// 本地解析到 IPv4 秒回。setDefaultResultOrder 影响全局默认解析顺序（node:http/
// axios/undici 均生效），避免逐个 getter 打补丁。
dns.setDefaultResultOrder('ipv4first');

// 未捕获的 rejection/异常记录日志后以非零码退出（supervisor 语义：pm2/Docker 检测到
// 退出码后自动重启），不再「只记录不退出」——后者会掩盖真实故障让进程带病存活。
process.on('unhandledRejection', (reason) => {
    console.error(
        `[unhandledRejection] ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
    );
    process.exit(1);
});
process.on('uncaughtException', (error) => {
    console.error(`[uncaughtException] ${error?.stack ?? error}`);
    process.exit(1);
});

import esMain from 'es-main';

import rootRouter, { handler, response } from 'handlers.js';

import fxmManager from './fxmManager';
import { installShutdown } from './shutdown';
import { restoreShutdownMetricsFromDisk } from './shutdownMetricsPersistence';
import { useBasic } from './handler/rest';
import { installRequestBodyLimit } from './handler/limits';

import getBOCFXRatesFromBOC from './FXGetter/boc';
import getBOCHKFxRates from './FXGetter/bochk';
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
import getNCBCNFXRates from './FXGetter/ncb.cn';
import getNCBHKFXRates from './FXGetter/ncb.hk';
import getXIBFXRates from './FXGetter/xib';
import getPABFXRates from './FXGetter/pab';
import getCEBFXRates from './FXGetter/ceb';
import getCMBCFXRates from './FXGetter/cmbc';
import getCGBFXRates from './FXGetter/cgb';
import getHXBFXRates from './FXGetter/hxb';
import getCBHBFXRates from './FXGetter/cbhb';
import getBOBFXRates from './FXGetter/bob';
import getBOSCFXRates from './FXGetter/bosc';
import getNJCBFXRates from './FXGetter/njcb';
import getHZBankFXRates from './FXGetter/hzbank';
import getGZCBFXRates from './FXGetter/gzcb';
import getHSBankFXRates from './FXGetter/hsbank';
import getBCQFXRates from './FXGetter/bcq';
import getBCSFXRates from './FXGetter/bcs';
import getCQTGFXRates from './FXGetter/cqtg';
import getGHBFXRates from './FXGetter/ghb';
import getHFBankFXRates from './FXGetter/hfbank';
import getZYBankFXRates from './FXGetter/zybank';
import getBOJSFXRates from './FXGetter/bojs';
import getECBFXRates from './FXGetter/ecb';
import getCFETSFXRates from './FXGetter/cfets';
import getDBSFXRates from './FXGetter/dbs';
import getDBSCNFXRates from './FXGetter/dbs.cn';
import getDBSHKFXRates from './FXGetter/dbs.hk';
import getAlipayFXRates from './FXGetter/alipay';
import getHKMAFXRates from './FXGetter/hkma';
import getHKABFXRates from './FXGetter/hkab';
import getCNCBIFXRates from './FXGetter/cncbi';
import getCCBAFXRates from './FXGetter/ccba';
import getCMBWLFXRates from './FXGetter/cmbwl';
import getHSBFXRates from './FXGetter/hsb';
import getICBCAFXRates from './FXGetter/icbca';
import getOCBCHKFXRates from './FXGetter/ocbchk';
import getOCBCFXRates from './FXGetter/ocbc';
import getBEAFXRates from './FXGetter/bea';

import mastercardFXM from './FXGetter/mastercard';
import visaFXM from './FXGetter/visa';
import { RSSHandler } from './handler/rss';

restoreShutdownMetricsFromDisk();

const Manager = new fxmManager({
    boc: getBOCFXRatesFromBOC,
    bochk: getBOCHKFxRates,
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
    'ncb.cn': getNCBCNFXRates,
    'ncb.hk': getNCBHKFXRates,
    spdb: getSPDBFXRates,
    xib: getXIBFXRates,
    pab: getPABFXRates,
    ceb: getCEBFXRates,
    cmbc: getCMBCFXRates,
    cgb: getCGBFXRates,
    hxb: getHXBFXRates,
    cbhb: getCBHBFXRates,
    bob: getBOBFXRates,
    bosc: getBOSCFXRates,
    njcb: getNJCBFXRates,
    hzbank: getHZBankFXRates,
    gzcb: getGZCBFXRates,
    hsbank: getHSBankFXRates,
    bcq: getBCQFXRates,
    bcs: getBCSFXRates,
    cqtg: getCQTGFXRates,
    ghb: getGHBFXRates,
    hfbank: getHFBankFXRates,
    zybank: getZYBankFXRates,
    bojs: getBOJSFXRates,
    ecb: getECBFXRates,
    cfets: getCFETSFXRates,
    dbs: getDBSFXRates,
    'dbs.cn': getDBSCNFXRates,
    'dbs.hk': getDBSHKFXRates,
    alipay: getAlipayFXRates,
    hkma: getHKMAFXRates,
    hkab: getHKABFXRates,
    cncbi: getCNCBIFXRates,
    ccba: getCCBAFXRates,
    cmbwl: getCMBWLFXRates,
    hsb: getHSBFXRates,
    icbca: getICBCAFXRates,
    ocbchk: getOCBCHKFXRates,
    ocbc: getOCBCFXRates,
    bea: getBEAFXRates,
});

Manager.registerFXM('mastercard', new mastercardFXM());
Manager.registerFXM('visa', new visaFXM());

if (process.env.ENABLE_WISE != '0') {
    if (process.env.WISE_TOKEN == undefined) {
        console.error('WISE_TOKEN is not set. Use Wise Token from web.');
        process.env.WISE_USE_TOKEN_FROM_WEB = '1';
    }
    Manager.registerGetter(
        'wise',
        getWiseFXRates(
            process.env.WISE_SANDBOX_API == '1',
            process.env.WISE_USE_TOKEN_FROM_WEB != '0',
            process.env.WISE_TOKEN!,
        ),
    );
}

export const makeInstance = async (App: rootRouter, Manager: fxmManager) => {
    App.binding(
        '/(.*)',
        new handler('ANY', [
            async (_request, response: response<any>) => {
                useBasic(response);
                response.status = 404;
            },
        ]),
    );

    App.useMappingAdapter();

    // Phase 1 RPC 入口硬限制：本地监听与 Vercel 默认 handler 共用同一 adapter 实例，
    // 在 listen/dispatch 之前装上受限 body 读取器（256 KiB 预检 + 流式溢出），
    // 超限请求在进入 router/getter 之前直接 413。
    installRequestBodyLimit(App.adapater);

    App.binding(
        '/',
        App.create('ANY', async () => '200 OK\n\n/info - Instance Info\n'),
    );

    App.binding(
        '/(.*)',
        new handler('ANY', [
            async (request, response: response<any>) => {
                Manager.log(
                    `${request.ip} ${request.method} ${request.originURL}`,
                );

                response.headers.set('X-Powered-By', `fxrate/latest`);
                response.headers.set(
                    'X-License',
                    'MIT, Data copyright belongs to its source. More details at <https://github.com/186526/fxrate>.',
                );
            },
        ]),
    );

    App.use([Manager], '/(.*)');
    App.use([Manager], '/v1/(.*)');

    const rssFeeder = new RSSHandler(Manager);
    App.use([rssFeeder], '/rss/(.*)');

    return App;
};

if (
    process.env.VERCEL == '1' ||
    ((_) => globalThis.esBuilt ?? esMain(_))(import.meta)
) {
    (async () => {
        globalThis.App = await makeInstance(new rootRouter(), Manager);

        const port = Number(process?.env?.PORT) || 8080;

        if (process.env.VERCEL != '1') {
            await globalThis.App.listen(port);

            // 保留本地 HTTP server 句柄（handlers.js Node adapter 的内部 server），
            // 安装优雅停机：SIGTERM/SIGINT 后停止接收新连接、停定时器、落盘快照一次，
            // 等待在途请求自然结束后 exit 0，超时可配置硬截止强制退出。
            const localServer = (
                globalThis.App.adapater as unknown as { server: http.Server }
            ).server;
            installShutdown(localServer, Manager);
        }

        console.log(
            `[${new Date().toUTCString()}] Server is started at ${port} with NODE_ENV ${process.env.NODE_ENV || 'development'}.`,
        );
    })();
}

export default async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const request = await globalThis.App.adapater.handleRequest(req);
    const response = await globalThis.App.adapater.router.respond(request);
    globalThis.App.adapater.handleResponse(response, res);
};

export { Manager };
