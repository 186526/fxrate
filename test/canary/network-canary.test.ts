// network-canary（Phase 6 §10.8）：真实上游健康度探针（scheduled + 手工触发）。
// 覆盖 plan §10.8 交付物：每源最小成功数、非空汇率、freshness 与允许失败清单。
//
// 运行（只在 scheduled/manual workflow 执行，不进入 PR 单元测试）：
//   RUN_NETWORK_TESTS=1 yarn test test/canary/network-canary.test.ts --runInBand --testTimeout=300000
//
// 默认（未设 RUN_NETWORK_TESTS=1）整包 skip——保证 `yarn test` / CI 单元测试不碰公网。
//
// 判定契约：
//   1. 每个成功来源至少返回一条合法汇率（finite/positive 报价、合法 updated）；
//      空数组、NaN/Infinity/非正值、非法 updated → 硬失败（exit 1）。
//   2. 数据 freshness 在来源声明的窗口内（DEFAULT_FRESHNESS_MS=7 天；
//      hkma 为月频滞后源 → 60 天；mastercard 未发布回退 7 天 → 8 天）。
//   3. 允许的 WAF/反爬失败逐项记录，但仍计入总失败预算。
//   4. 聚合门禁：成功来源数 >= MIN_SUCCESS_SOURCES；总失败数 <= MAX_TOTAL_FAILURES。
//      全部/过多来源失败、空数组或 freshness 超限都必须让测试失败。

import getBOCFXRatesFromBOC from '../../src/FXGetter/boc';
import getBOCHKFxRates from '../../src/FXGetter/bochk';
import getICBCFXRates from '../../src/FXGetter/icbc';
import getCIBFXRates, { getCIBHuanyuFXRates } from '../../src/FXGetter/cib';
import getCCBFXRates from '../../src/FXGetter/ccb';
import getABCFXRates from '../../src/FXGetter/abc';
import getBOCOMFXRates from '../../src/FXGetter/bocom';
import getPSBCFXRates from '../../src/FXGetter/psbc';
import getCMBFXRates from '../../src/FXGetter/cmb';
import getPBOCFXRates from '../../src/FXGetter/pboc';
import getUnionPayFXRates from '../../src/FXGetter/unionpay';
import getJCBFXRates from '../../src/FXGetter/jcb';
import getHSBCHKFXRates from '../../src/FXGetter/hsbc.hk';
import getHSBCCNFXRates from '../../src/FXGetter/hsbc.cn';
import getHSBCAUFXRates from '../../src/FXGetter/hsbc.au';
import getCITICCNFXRates from '../../src/FXGetter/citic.cn';
import getSPDBFXRates from '../../src/FXGetter/spdb';
import getNCBCNFXRates from '../../src/FXGetter/ncb.cn';
import getNCBHKFXRates from '../../src/FXGetter/ncb.hk';
import getXIBFXRates from '../../src/FXGetter/xib';
import getPABFXRates from '../../src/FXGetter/pab';
import getCEBFXRates from '../../src/FXGetter/ceb';
import getCMBCFXRates from '../../src/FXGetter/cmbc';
import getCGBFXRates from '../../src/FXGetter/cgb';
import getHXBFXRates from '../../src/FXGetter/hxb';
import getCBHBFXRates from '../../src/FXGetter/cbhb';
import getBOBFXRates from '../../src/FXGetter/bob';
import getBOSCFXRates from '../../src/FXGetter/bosc';
import getNJCBFXRates from '../../src/FXGetter/njcb';
import getHZBankFXRates from '../../src/FXGetter/hzbank';
import getGZCBFXRates from '../../src/FXGetter/gzcb';
import getHSBankFXRates from '../../src/FXGetter/hsbank';
import getBCQFXRates from '../../src/FXGetter/bcq';
import getBCSFXRates from '../../src/FXGetter/bcs';
import getCQTGFXRates from '../../src/FXGetter/cqtg';
import getGHBFXRates from '../../src/FXGetter/ghb';
import getHFBankFXRates from '../../src/FXGetter/hfbank';
import getZYBankFXRates from '../../src/FXGetter/zybank';
import getBOJSFXRates from '../../src/FXGetter/bojs';
import getECBFXRates from '../../src/FXGetter/ecb';
import getCFETSFXRates from '../../src/FXGetter/cfets';
import getDBSFXRates from '../../src/FXGetter/dbs';
import getDBSCNFXRates from '../../src/FXGetter/dbs.cn';
import getDBSHKFXRates from '../../src/FXGetter/dbs.hk';
import getAlipayFXRates from '../../src/FXGetter/alipay';
import getHKMAFXRates from '../../src/FXGetter/hkma';
import getHKABFXRates from '../../src/FXGetter/hkab';
import getCNCBIFXRates from '../../src/FXGetter/cncbi';
import getCCBAFXRates from '../../src/FXGetter/ccba';
import getCMBWLFXRates from '../../src/FXGetter/cmbwl';
import getHSBFXRates from '../../src/FXGetter/hsb';
import getICBCAFXRates from '../../src/FXGetter/icbca';
import getOCBCHKFXRates from '../../src/FXGetter/ocbchk';
import getOCBCFXRates from '../../src/FXGetter/ocbc';
import getBEAFXRates from '../../src/FXGetter/bea';
import getWiseFXRates from '../../src/FXGetter/wise';
import mastercardFXM from '../../src/FXGetter/mastercard';
import visaFXM from '../../src/FXGetter/visa';
import type fxManager from '../../src/fxm/fxManager';

import type { FXRate } from '../../src/types';
import {
    CANARY_HOOK_TIMEOUT_MS,
    CARD_FETCH_TIMEOUT_MS,
    DAY,
    DEFAULT_FETCH_TIMEOUT_MS,
    GETTER_CONCURRENCY,
    cardUpdatedDate,
    classifySource,
    fetchWithTimeout,
    toNum,
    type SourceResult,
    type SourceSpec,
} from './network-canary-contract';

// 聚合门禁：59 个来源（56 getter + wise + mastercard/visa）。
const MIN_SUCCESS_SOURCES = 48;
const MAX_TOTAL_FAILURES = 11;

// 显式来源配置：默认窗口 7 天覆盖日频牌价跨周末/节假日；特殊源单独声明。
// WAF 允许清单对应 AGENTS.md 记录的反爬源（Imperva/Cloudflare/签名 POST/legacy TLS）。
const SOURCE_SPECS: Record<string, SourceSpec> = {
    hkma: { freshnessMs: 60 * DAY }, // 金管局月频统计公报，数据滞后月余
    mastercard: { freshnessMs: 8 * DAY, allowedWafFailure: true }, // Akamai + 未发布向前回退最多 7 天
    visa: { allowedWafFailure: true, fetchTimeoutMs: CARD_FETCH_TIMEOUT_MS }, // Cloudflare + headless chromium
    bea: { allowedWafFailure: true }, // Imperva WAF，仅 Playwright 可抓
    ocbchk: { allowedWafFailure: true }, // 需 5 个 x-* 头 + UUID 的签名 POST
    icbca: { allowedWafFailure: true }, // 需 legacy TLS renegotiation Agent
    wise: { allowedWafFailure: true }, // 网页 token / WAF 变更可能阻断公开接口
};

const getters: Record<string, () => Promise<FXRate[]>> = {
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
    // wise 是工厂函数；生产默认走网页 token（WISE_USE_TOKEN_FROM_WEB=1）
    wise: getWiseFXRates(false, true, ''),
};

// mastercard/visa 是 FXM 类（懒加载 + 异步请求），抽查关键货币对。
const fxmLazySources: Record<string, () => fxManager> = {
    mastercard: () => new mastercardFXM(),
    visa: () => new visaFXM(),
};

const EXPECTED_SOURCE_COUNT = 59;
const configuredSourceCount =
    Object.keys(getters).length + Object.keys(fxmLazySources).length;
if (configuredSourceCount !== EXPECTED_SOURCE_COUNT) {
    throw new Error(
        `network canary source list mismatch: ${configuredSourceCount} != ${EXPECTED_SOURCE_COUNT}`,
    );
}

const KEY_PAIRS: [string, string][] = [
    ['USD', 'CNY'],
    ['EUR', 'CNY'],
    ['JPY', 'CNY'],
    ['GBP', 'CNY'],
    ['HKD', 'CNY'],
    ['AUD', 'CNY'],
    ['CAD', 'CNY'],
];

const runNetwork = process.env.RUN_NETWORK_TESTS === '1';

// 未显式启用 RUN_NETWORK_TESTS=1 时整包跳过（canary 只在 scheduled/manual workflow 跑）。
const maybe = runNetwork ? describe : describe.skip;

maybe('network canary（真实上游健康度）', () => {
    const results: SourceResult[] = [];
    const now = Date.now();

    beforeAll(async () => {
        const sources = Object.keys(getters);
        let idx = 0;
        const worker = async () => {
            while (idx < sources.length) {
                const source = sources[idx++]!;
                const spec = SOURCE_SPECS[source] ?? {};
                const timeoutMs =
                    spec.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
                try {
                    const rates = await fetchWithTimeout(
                        getters[source]!(),
                        timeoutMs,
                        source,
                    );
                    results.push(
                        classifySource(source, rates, spec, null, now),
                    );
                    console.log(
                        `[fetched] ${source}: ${rates.length} 条 (fresh=最新 ${results[results.length - 1]?.latestUpdated?.toISOString() ?? 'n/a'})`,
                    );
                } catch (e) {
                    results.push(
                        classifySource(
                            source,
                            [],
                            spec,
                            (e as Error).message,
                            now,
                        ),
                    );
                    console.log(
                        `[fetch-fail] ${source}: ${(e as Error).message}`,
                    );
                }
            }
        };
        const getterWork = Promise.all(
            Array.from({ length: GETTER_CONCURRENCY }, worker),
        );

        // Card 两源与普通 getter 同时执行；每源 7 个货币对也并行，故理论最坏
        // 包装 timeout 为 max(ceil(57/12)*30s, 45s)，显著低于 290s hook deadline。
        const cardWork = Promise.all(
            Object.entries(fxmLazySources).map(async ([source, factory]) => {
                const fxm = factory();
                const spec = SOURCE_SPECS[source] ?? {};
                const timeoutMs =
                    spec.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
                const rates: FXRate[] = [];
                const pairErrors: string[] = [];
                await Promise.all(
                    KEY_PAIRS.map(async ([from, to]) => {
                        try {
                            const rate = await fetchWithTimeout(
                                (async () => {
                                    const t = await fxm.getfxRateList(
                                        from as never,
                                        to as never,
                                    );
                                    const middle = toNum(t?.middle);
                                    if (
                                        middle === undefined ||
                                        !Number.isFinite(middle) ||
                                        middle <= 0
                                    ) {
                                        throw new Error(
                                            `${source}/${from}-${to} 无有效报价 (middle=${String(t?.middle)})`,
                                        );
                                    }
                                    return {
                                        currency: { from, to },
                                        rate: { middle: t?.middle },
                                        unit: 1,
                                        updated: cardUpdatedDate(t?.updated),
                                    } as FXRate;
                                })(),
                                timeoutMs,
                                `${source}/${from}-${to}`,
                            );
                            rates.push(rate);
                        } catch (e) {
                            const message = `${source}/${from}-${to}: ${(e as Error).message}`;
                            pairErrors.push(message);
                            console.log(`[fetch-fail] ${message}`);
                        }
                    }),
                );
                const allFailed = rates.length === 0 && pairErrors.length > 0;
                results.push(
                    allFailed
                        ? classifySource(
                              source,
                              [],
                              spec,
                              pairErrors.join('; '),
                              now,
                          )
                        : classifySource(source, rates, spec, null, now),
                );
                console.log(
                    `[fetched] ${source}: 抽查 ${rates.length}/${KEY_PAIRS.length} 对`,
                );
            }),
        );

        await Promise.all([getterWork, cardWork]);

        console.log(`\n===== network canary 汇总 =====`);
        for (const r of results) {
            const mark =
                r.status === 'ok'
                    ? '✓'
                    : r.status === 'waf-failure'
                      ? '~'
                      : '✗';
            console.log(
                `  ${mark} ${r.source}: ${r.status} (${r.rateCount} 条${r.latestUpdated ? `, 最新 ${r.latestUpdated.toISOString()}` : ''})`,
            );
            for (const issue of r.issues) console.log(`      ${issue}`);
        }
    }, CANARY_HOOK_TIMEOUT_MS);

    test('每个成功来源返回非空、合法且新鲜的汇率', () => {
        // 空数组 / 非法报价 / 陈旧数据在「成功抓取」的情况下必须硬失败——
        // 包括允许 WAF 失败的来源（允许只豁免抓取失败，不豁免坏数据）。
        const bad = results.filter((r) =>
            ['empty', 'invalid', 'stale'].includes(r.status),
        );
        const details = bad.flatMap((r) => r.issues);
        expect(details).toEqual([]);
    });

    test('聚合门禁：成功来源达到最低阈值、总失败不超过上限', () => {
        expect(results).toHaveLength(EXPECTED_SOURCE_COUNT);
        const success = results.filter((r) => r.status === 'ok').length;
        const hardFailures = results.filter((r) =>
            ['failed', 'empty', 'invalid', 'stale'].includes(r.status),
        ).length;
        const totalFailures = results.length - success;
        console.log(
            `\n  成功 ${success}/${results.length}，总失败 ${totalFailures}（硬失败 ${hardFailures}，允许 WAF 失败 ${results.filter((r) => r.status === 'waf-failure').length}）`,
        );
        expect(success).toBeGreaterThanOrEqual(MIN_SUCCESS_SOURCES);
        expect(totalFailures).toBeLessThanOrEqual(MAX_TOTAL_FAILURES);
    });
});
