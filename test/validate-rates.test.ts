/**
 * 汇率数值断言测试（真实网络请求）。
 *
 * 运行：
 *   NODE_OPTIONS=--experimental-vm-modules node node_modules/jest/bin/jest.js test/validate-rates.test.ts --testTimeout=600000
 *
 * 依赖真实网络与各数据源可用性，CI 中通过 RUN_NETWORK_TESTS=1 显式启用；
 * 默认跳过（测试体套件标注 skip）。
 *
 * 检查项：
 *   1. 数值合法性：非 NaN、非 Infinity、非零、非负
 *   2. buy < sell（银行惯例；注意 CNH 等特殊货币的买价可能高于卖价，见 ncb.hk 注释）
 *   3. middle 落在 [buy, sell] 区间内（当三者都存在时）
 *   4. updated 日期有效性：非 Invalid Date、非未来日期
 *   5. 交叉源一致性：同一货币对（标准化方向）在各源之间数值应接近
 */
import getBOCFXRatesFromBOC from '../src/FXGetter/boc';
import getBOCHKFxRates from '../src/FXGetter/bochk';
import getICBCFXRates from '../src/FXGetter/icbc';
import getCIBFXRates, { getCIBHuanyuFXRates } from '../src/FXGetter/cib';
import getCCBFXRates from '../src/FXGetter/ccb';
import getABCFXRates from '../src/FXGetter/abc';
import getBOCOMFXRates from '../src/FXGetter/bocom';
import getPSBCFXRates from '../src/FXGetter/psbc';
import getCMBFXRates from '../src/FXGetter/cmb';
import getPBOCFXRates from '../src/FXGetter/pboc';
import getUnionPayFXRates from '../src/FXGetter/unionpay';
import getJCBFXRates from '../src/FXGetter/jcb';
import getHSBCHKFXRates from '../src/FXGetter/hsbc.hk';
import getHSBCCNFXRates from '../src/FXGetter/hsbc.cn';
import getHSBCAUFXRates from '../src/FXGetter/hsbc.au';
import getCITICCNFXRates from '../src/FXGetter/citic.cn';
import getSPDBFXRates from '../src/FXGetter/spdb';
import getNCBCNFXRates from '../src/FXGetter/ncb.cn';
import getNCBHKFXRates from '../src/FXGetter/ncb.hk';
import getXIBFXRates from '../src/FXGetter/xib';
import getPABFXRates from '../src/FXGetter/pab';
import getCEBFXRates from '../src/FXGetter/ceb';
import getCMBCFXRates from '../src/FXGetter/cmbc';
import getCGBFXRates from '../src/FXGetter/cgb';
import getHXBFXRates from '../src/FXGetter/hxb';
import getCBHBFXRates from '../src/FXGetter/cbhb';
import getBOBFXRates from '../src/FXGetter/bob';
import getBOSCFXRates from '../src/FXGetter/bosc';
import getNJCBFXRates from '../src/FXGetter/njcb';
import getHZBankFXRates from '../src/FXGetter/hzbank';
import getGZCBFXRates from '../src/FXGetter/gzcb';
import getHSBankFXRates from '../src/FXGetter/hsbank';
import getBCQFXRates from '../src/FXGetter/bcq';
import getBCSFXRates from '../src/FXGetter/bcs';
import getCQTGFXRates from '../src/FXGetter/cqtg';
import getGHBFXRates from '../src/FXGetter/ghb';
import getHFBankFXRates from '../src/FXGetter/hfbank';
import getZYBankFXRates from '../src/FXGetter/zybank';
import getBOJSFXRates from '../src/FXGetter/bojs';
import mastercardFXM from '../src/FXGetter/mastercard';
import visaFXM from '../src/FXGetter/visa';
import type fxManager from '../src/fxm/fxManager';

import type { FXRate } from '../src/types';

const getters: { [source: string]: () => Promise<FXRate[]> } = {
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
};

// mastercard/visa 是 FXM 类（懒加载 + 异步请求），抽查关键货币对。
const fxmLazySources: { [source: string]: () => fxManager } = {
    mastercard: () => new mastercardFXM(),
    visa: () => new visaFXM(),
};

const KEY_PAIRS: [string, string][] = [
    ['USD', 'CNY'],
    ['EUR', 'CNY'],
    ['JPY', 'CNY'],
    ['GBP', 'CNY'],
    ['HKD', 'CNY'],
    ['AUD', 'CNY'],
    ['CAD', 'CNY'],
];

function toNum(v: unknown): number | undefined {
    if (v === undefined || v === null) return undefined;
    return Number(
        typeof v === 'object' ? (v as { toString(): string }).toString() : v,
    );
}

function checkNumericValidity(
    rate: FXRate,
    source: string,
    pair: string,
): string[] {
    const errs: string[] = [];
    const r = rate.rate;
    const checks: [string, number | undefined][] = [
        ['buy.cash', toNum(r.buy?.cash)],
        ['buy.remit', toNum(r.buy?.remit)],
        ['sell.cash', toNum(r.sell?.cash)],
        ['sell.remit', toNum(r.sell?.remit)],
        ['middle', toNum(r.middle)],
    ];
    for (const [label, n] of checks) {
        if (n === undefined) continue;
        if (Number.isNaN(n)) errs.push(`${source} ${pair} ${label}=NaN`);
        else if (!Number.isFinite(n))
            errs.push(`${source} ${pair} ${label}=Infinity`);
        else if (n <= 0) errs.push(`${source} ${pair} ${label}=${n} (非正)`);
    }
    return errs;
}

function checkBuySellSpread(
    rate: FXRate,
    source: string,
    pair: string,
): string[] {
    const errs: string[] = [];
    const r = rate.rate;
    const buyRemit = toNum(r.buy?.remit);
    const sellRemit = toNum(r.sell?.remit);
    const buyCash = toNum(r.buy?.cash);
    const sellCash = toNum(r.sell?.cash);
    const middle = toNum(r.middle);

    // 注意：离岸人民币（CNH）等货币的银行买入价可能高于卖出价（ncb.hk 实测）；
    // 部分源（unionpay 单一中间价、abc/cib 小币种）buy 与 sell 相同也属正常。
    // 因此只在「buy 明显高于 sell」（差值 > 0.5%）时报错，容忍相等。
    const isCnhRelated = pair.includes('CNH') || pair.startsWith('CNY/');
    if (
        !isCnhRelated &&
        buyRemit !== undefined &&
        sellRemit !== undefined &&
        buyRemit > sellRemit * 1.005
    ) {
        errs.push(
            `${source} ${pair} 汇买卖倒挂: buy.remit(${buyRemit}) > sell.remit(${sellRemit}) 超 0.5%`,
        );
    }
    if (
        !isCnhRelated &&
        buyCash !== undefined &&
        sellCash !== undefined &&
        buyCash > sellCash * 1.005
    ) {
        errs.push(
            `${source} ${pair} 钞买卖倒挂: buy.cash(${buyCash}) > sell.cash(${sellCash}) 超 0.5%`,
        );
    }
    // middle 是银行公布的折算价，可能合法地略偏离买卖价区间，放宽到 ±3%。
    if (middle !== undefined) {
        if (buyRemit !== undefined && middle < buyRemit * 0.97) {
            errs.push(
                `${source} ${pair} middle(${middle}) 低于 buy.remit(${buyRemit}) 超 3%`,
            );
        }
        if (sellRemit !== undefined && middle > sellRemit * 1.03) {
            errs.push(
                `${source} ${pair} middle(${middle}) 高于 sell.remit(${sellRemit}) 超 3%`,
            );
        }
    }
    return errs;
}

function normalize(
    rate: FXRate,
): { base: string; quote: string; val: number } | null {
    const from = rate.currency.from as string;
    const to = rate.currency.to as string;
    const middle = toNum(rate.rate.middle);
    if (middle === undefined || middle <= 0 || !rate.unit) return null;
    const perUnit = middle / rate.unit;
    if (to === 'CNY' || to === 'CNH') {
        return { base: from, quote: 'CNY', val: perUnit };
    }
    if (from === 'CNY' || from === 'CNH') {
        return { base: to, quote: 'CNY', val: 1 / perUnit };
    }
    return null;
}

const runNetwork = process.env.RUN_NETWORK_TESTS === '1';

// 未显式启用 RUN_NETWORK_TESTS=1 时跳过（真实网络依赖外部源，不适合默认 CI）。
const maybe = runNetwork ? describe : describe.skip;

maybe('FXRate 数值检查（真实网络）', () => {
    const results: { [source: string]: { rates: FXRate[]; errs: string[] } } =
        {};

    beforeAll(async () => {
        const sources = Object.keys(getters);
        const CONCURRENCY = 6;
        let idx = 0;
        const worker = async () => {
            while (idx < sources.length) {
                const source = sources[idx++];
                try {
                    const rates = await Promise.race([
                        getters[source](),
                        new Promise<never>((_, rej) =>
                            setTimeout(
                                () => rej(new Error('timeout 30s')),
                                30_000,
                            ),
                        ),
                    ]);
                    results[source] = { rates, errs: [] };
                    console.log(`[ok] ${source}: ${rates.length} 条`);
                } catch (e) {
                    results[source] = { rates: [], errs: [] };
                    console.log(
                        `[fetch-fail] ${source}: ${(e as Error).message}`,
                    );
                }
            }
        };
        await Promise.all(Array.from({ length: CONCURRENCY }, worker));

        // mastercard/visa：FXM 类，通过 async getfxRateList 抽查关键货币对。
        for (const [source, factory] of Object.entries(fxmLazySources)) {
            const fxm = factory();
            const rates: FXRate[] = [];
            for (const [from, to] of KEY_PAIRS) {
                try {
                    const x = await Promise.race([
                        (async () => {
                            const t = await fxm.getfxRateList(
                                from as never,
                                to as never,
                            );
                            return {
                                currency: { from, to },
                                rate: { middle: t?.middle },
                                unit: 1,
                                updated: t?.updated ?? new Date(),
                            } as FXRate;
                        })(),
                        new Promise<never>((_, rej) =>
                            setTimeout(
                                () => rej(new Error('timeout 30s')),
                                30_000,
                            ),
                        ),
                    ]);
                    rates.push(x);
                } catch (e) {
                    console.log(
                        `[fetch-fail] ${source}/${from}-${to}: ${(e as Error).message}`,
                    );
                }
            }
            results[source] = { rates, errs: [] };
            console.log(
                `[ok] ${source}: 抽查 ${rates.length}/${KEY_PAIRS.length} 对`,
            );
        }

        for (const source of Object.keys(results)) {
            for (const rate of results[source].rates) {
                const pair = `${rate.currency.from}/${rate.currency.to}`;
                results[source].errs.push(
                    ...checkNumericValidity(rate, source, pair),
                );
                results[source].errs.push(
                    ...checkBuySellSpread(rate, source, pair),
                );
            }
        }

        const now = Date.now();
        for (const source of Object.keys(results)) {
            for (const rate of results[source].rates) {
                const d = new Date(rate.updated);
                if (Number.isNaN(d.getTime())) {
                    results[source].errs.push(
                        `${source} ${rate.currency.from}/${rate.currency.to} updated=Invalid Date`,
                    );
                } else if (d.getTime() > now + 24 * 3600 * 1000) {
                    results[source].errs.push(
                        `${source} ${rate.currency.from}/${rate.currency.to} updated 在未来: ${d.toISOString()}`,
                    );
                }
            }
        }
    }, 600_000);

    test('各源单源数值检查 + 买卖价关系', () => {
        const allErrs: string[] = [];
        for (const source of Object.keys(results)) {
            for (const e of results[source].errs) allErrs.push(e);
        }
        console.log('\n===== 单源检查 =====');
        for (const source of Object.keys(results)) {
            const errs = results[source].errs;
            if (errs.length === 0) console.log(`  ✓ ${source}`);
            else {
                console.log(`  ✗ ${source} (${errs.length} 项)`);
                for (const e of errs.slice(0, 10)) console.log(`      ${e}`);
            }
        }
        expect(allErrs).toEqual([]);
    });

    test('交叉源一致性', () => {
        const crossMap: { [key: string]: { source: string; val: number }[] } =
            {};
        for (const source of Object.keys(results)) {
            for (const rate of results[source].rates) {
                const norm = normalize(rate);
                if (!norm) continue;
                const key = `${norm.base}/${norm.quote}`;
                if (!crossMap[key]) crossMap[key] = [];
                crossMap[key].push({ source, val: norm.val });
            }
        }
        console.log('\n===== 交叉源一致性 =====');
        const issues: string[] = [];
        // 大币种各银行牌价应高度一致（≤5%）；小币种（RUB/ZAR/MNT 等）因银行点差
        // 和报价单位差异天然可达 20%+，放宽阈值避免误报。
        const MAJOR = new Set([
            'USD',
            'EUR',
            'GBP',
            'JPY',
            'HKD',
            'AUD',
            'CAD',
            'CHF',
            'SGD',
        ]);
        // 制裁/特殊货币（RUB）各银行牌价差异极大，不做交叉一致性校验。
        const EXEMPT = new Set(['RUB']);
        for (const key of Object.keys(crossMap).sort()) {
            const entries = crossMap[key];
            if (entries.length < 2) continue;
            const vals = entries.map((e) => e.val);
            const min = Math.min(...vals);
            const max = Math.max(...vals);
            const base = key.split('/')[0];
            const threshold = MAJOR.has(base) ? 1.05 : 1.2;
            if (EXEMPT.has(base)) {
                console.log(
                    `  - ${key}: ${entries.length} 源（豁免，差异 ${((max / min - 1) * 100).toFixed(1)}%）`,
                );
                continue;
            }
            if (max / min > threshold) {
                const line = `${key}: ${entries.map((e) => `${e.source}=${e.val.toFixed(4)}`).join(', ')} (偏差 ${((max / min - 1) * 100).toFixed(1)}%)`;
                console.log(`  ✗ ${line}`);
                issues.push(line);
            } else {
                console.log(
                    `  ✓ ${key}: ${entries.length} 源一致 (${min.toFixed(4)}~${max.toFixed(4)})`,
                );
            }
        }
        expect(issues).toEqual([]);
    });
});
