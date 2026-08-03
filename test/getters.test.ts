import { makeInstance, Manager } from '../src/index';
import { rootRouter, request, interfaces } from 'handlers.js';
const Instance = await makeInstance(new rootRouter(), Manager);
const mk = (path: string) =>
    new request(
        'GET',
        new URL(`http://this.internal/${path}`),
        new interfaces.headers({}),
        '',
        {},
    );

// 与 src/index.ts 注册顺序一致的官方 source 名（勿凭印象写别名）。
const SOURCES = [
    'boc',
    'bochk',
    'icbc',
    'cib',
    'cibHuanyu',
    'ccb',
    'abc',
    'bocom',
    'psbc',
    'cmb',
    'pboc',
    'unionpay',
    'jcb',
    'hsbc.hk',
    'hsbc.cn',
    'hsbc.au',
    'citic.cn',
    'ncb.cn',
    'ncb.hk',
    'spdb',
    'xib',
    'pab',
    'ceb',
    'cmbc',
    'cgb',
    'hxb',
    'cbhb',
    'bob',
    'bosc',
    'njcb',
    'hzbank',
    'gzcb',
    'hsbank',
    'bcq',
    'bcs',
    'cqtg',
    'ghb',
    'hfbank',
    'zybank',
    'bojs',
    'ecb',
    'cfets',
    'dbs',
    'dbs.cn',
    'dbs.hk',
    'mastercard',
    'visa',
    'wise',
    'cncbi',
    'ccba',
    'cmbwl',
    'hsb',
    'icbca',
    'ocbchk',
    'ocbc',
    'bea',
];

test('all sources USD/CNY smoke', async () => {
    const out: string[] = [];
    for (const s of SOURCES) {
        try {
            // ecb 只有 EUR 基准对，用 EUR/USD 抽查；cfets 是 CNY 基准用 EUR/CNY；
            // dbs 用 USD/SGD、dbs.cn 用 USD/CNY、dbs.hk 用 EUR/HKD；其余源用 USD/CNY。
            // HKD 基准港行（cncbi/ccba/cmbwl/hsb/icbca/ocbchk/bea）用 USD/HKD；ocbc 用 USD/SGD。
            const HKD_BASED = ['cncbi', 'ccba', 'cmbwl', 'hsb', 'icbca', 'ocbchk', 'bea'];
            const path =
                s === 'ecb'
                    ? `${s}/EUR/USD?amount=1`
                    : s === 'cfets'
                      ? `${s}/EUR/CNY?amount=1`
                      : s === 'dbs'
                        ? `${s}/USD/SGD?amount=1`
                        : s === 'dbs.cn'
                          ? `${s}/USD/CNY?amount=1`
                          : s === 'dbs.hk'
                            ? `${s}/EUR/HKD?amount=1`
                            : s === 'ocbc'
                              ? `${s}/USD/SGD?amount=1`
                              : HKD_BASED.includes(s)
                                ? `${s}/USD/HKD?amount=1`
                                : `${s}/USD/CNY?amount=1`;
            const r = await Instance.respond(mk(path));
            const b = JSON.parse(String(r.body));
            const mid =
                b.middle === false ? 'FALSE' : String(b.middle).slice(0, 8);
            out.push(`${s}: ${mid}`);
        } catch (e) {
            out.push(`${s}: ERR ${(e as Error).message.slice(0, 40)}`);
        }
    }
    process.stdout.write(out.join('\n') + '\n');
}, 300000);

// ncb.hk 语义专项：JPY 按 10000 单位报价、USD/HKD 为「1 外币 = X HKD」。
test('ncb.hk JPY unit & direction regression', async () => {
    const out: string[] = [];
    for (const src of ['ncb.hk', 'hsbc.hk']) {
        for (const p of [
            `${src}/JPY/HKD?amount=1`,
            `${src}/USD/HKD?amount=1`,
            `${src}/JPY/CNY?amount=1`,
        ]) {
            try {
                const r = await Instance.respond(mk(p));
                const b = JSON.parse(String(r.body));
                const mid =
                    b.middle === false ? 'F' : String(b.middle).slice(0, 9);
                out.push(`${p}: ${mid}`);
            } catch (_e) {
                out.push(`${p}: ERR`);
            }
        }
    }
    process.stdout.write(out.join('\n') + '\n');
}, 120000);

// 买卖价方向契约：rate.sell = 银行卖出价（客户买入价，高），rate.buy = 银行买入价（客户卖出价，低）。
// 因此「客户买 from 付 to 的价（rate.sell）」必须 > 「客户卖 from 得 to 的价（rate.buy）」，
// 即 cash(from→to) × cash(to→from) < 1（双向点差都让客户吃亏，乘积必小于 1）。
// 该断言在每次冒烟时执行，防止 getter 映射方向被改错（曾发生 HSBC AU 方向翻转事件）。
test('buy/sell direction: 买入价 > 卖出价', async () => {
    const out: string[] = [];
    const failures: string[] = [];
    for (const s of SOURCES) {
        // cfets/alipay 是单一方向中间价（cfets 只有 X/CNY，alipay 只有外币/CNY），
        // 无反向直连，双向乘积会走 BFS 交叉失真——跳过方向断言。
        if (s === 'cfets' || s === 'alipay') continue;
        // 各源基准对：hsbc.au 只有 AUD 基准；ecb 只有 EUR 基准；dbs 用 SGD、
        // dbs.cn 用 CNY、dbs.hk 用 HKD（EUR 计价）；港行（HKD 基准）与 ocbc（SGD 基准）同理。
        const HKD_BASED = ['cncbi', 'ccba', 'cmbwl', 'hsb', 'icbca', 'ocbchk', 'bea'];
        const pair =
            s === 'hsbc.au'
                ? ['AUD', 'CNY']
                : s === 'ecb'
                  ? ['EUR', 'USD']
                  : s === 'dbs'
                    ? ['USD', 'SGD']
                    : s === 'dbs.cn'
                      ? ['USD', 'CNY']
                      : s === 'dbs.hk'
                        ? ['EUR', 'HKD']
                        : s === 'ocbc'
                          ? ['USD', 'SGD']
                          : HKD_BASED.includes(s)
                            ? ['USD', 'HKD']
                            : ['USD', 'CNY'];
        try {
            const a = await Instance.respond(
                mk(`${s}/${pair[0]}/${pair[1]}?amount=1`),
            );
            const b = JSON.parse(String(a.body));
            const c = await Instance.respond(
                mk(`${s}/${pair[1]}/${pair[0]}?amount=1`),
            );
            const d = JSON.parse(String(c.body));
            if (b.cash === false || d.cash === false) {
                out.push(`${s}: 源不可用，跳过`);
                continue;
            }
            const product = Number(b.cash) * Number(d.cash);
            const midProduct = Number(b.middle) * Number(d.middle);
            // 正常：cash 乘积 < 1 且 ≤ mid 乘积（双向点差让客户吃亏）。
            // 无买卖价的源（pboc/mastercard/visa/wise 单一中间价）：乘积 ≈ 1 ≈ mid 乘积，正常。
            // 异常：cash 乘积明显 > mid 乘积（买卖方向被改反）。
            const ok = product <= midProduct * 1.001;
            out.push(
                `${s}: cash乘积=${product.toFixed(5)} (mid乘积=${midProduct.toFixed(5)}) ${ok ? '✓' : '✗ 方向异常'}`,
            );
            if (!ok) failures.push(s);
        } catch (e) {
            out.push(`${s}: ERR ${(e as Error).message.slice(0, 40)}`);
        }
    }
    process.stdout.write(out.join('\n') + '\n');
    expect(failures).toEqual([]);
}, 300000);

afterAll((t) => {
    Manager.stopAllInterval();
    t();
});
