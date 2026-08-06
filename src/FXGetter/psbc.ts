import axios from 'axios';
import { FXRate, currency } from 'src/types.d';
import { parseYYYYMMDDHHmmss } from './ncb.cn';

import https from 'https';
import crypto from 'crypto';

interface psbcRateItem {
    flag: number;
    cur: string;
    fe_buy_prc: number;
    fc_buy_prc: number;
    fe_sell_prc: number;
    mid_prc: number;
    effect_date: string;
    effect_time: string;
}

const allowPSBCCertificateforNodeJsOptions = {
    httpsAgent: new https.Agent({
        // allow sb PSBC to use legacy renegotiation
        secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
    }),
};

const getPSBCFXRates = async () => {
    const res = await axios.get(
        'https://s.psbc.com/portal/PsbcService/foreignexchange/curr',
        {
            ...allowPSBCCertificateforNodeJsOptions,
            timeout: 10000,
            headers: {
                'User-Agent':
                    process.env['HEADER_USER_AGENT'] ?? 'fxrate axios/latest',
            },
        },
    );

    const data = JSON.parse(
        res.data.replaceAll('empty(', '').replaceAll(')', ''),
    ).resultList;

    // 上游所有报价字段都是字符串（如 "673.4300"，百单位口径，flag==2 为人民币兑外币
    // 即购汇方向）：必须转 number，否则 Phase 3 严格校验整批拒绝。部分货币某些字段为
    // 空串（如 fc_sell_prc）——任一映射字段缺失/非正数则跳过该行，避免单行坏数据
    // 拖垮整源（旧实现整批失败导致该源 pending）。
    const toNumber = (v: unknown): number | null => {
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? n : null;
    };

    const answer = data
        .filter((k: psbcRateItem) => k.flag == 2)
        .map((fx: psbcRateItem) => {
            const buyRemit = toNumber(fx.fe_buy_prc);
            const buyCash = toNumber(fx.fc_buy_prc);
            const sell = toNumber(fx.fe_sell_prc);
            const middle = toNumber(fx.mid_prc);
            if (
                buyRemit == null ||
                buyCash == null ||
                sell == null ||
                middle == null
            ) {
                return null;
            }
            return {
                currency: {
                    from: fx.cur as unknown as currency.unknown,
                    to: 'CNY' as currency.CNY,
                },
                rate: {
                    buy: {
                        remit: buyRemit,
                        cash: buyCash,
                    },
                    sell: {
                        remit: sell,
                        cash: sell,
                    },
                    middle,
                },
                unit: 100,
                updated: parseYYYYMMDDHHmmss(
                    `${fx.effect_date}${fx.effect_time}`,
                ),
            } as FXRate;
        })
        .filter((fx): fx is FXRate => fx !== null)
        .sort();

    return answer;
};

export default getPSBCFXRates;
