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

    const answer = data
        .filter((k: psbcRateItem) => k.flag == 2)
        .map((fx: psbcRateItem) => {
            return {
                currency: {
                    from: fx.cur as unknown as currency.unknown,
                    to: 'CNY' as currency.CNY,
                },
                rate: {
                    buy: {
                        remit: fx.fe_buy_prc,
                        cash: fx.fc_buy_prc,
                    },
                    sell: {
                        remit: fx.fe_sell_prc,
                        cash: fx.fe_sell_prc,
                    },
                    middle: fx.mid_prc,
                },
                unit: 100,
                updated: parseYYYYMMDDHHmmss(
                    `${fx.effect_date}${fx.effect_time}`,
                ),
            } as FXRate;
        })
        .sort();

    return answer;
};

export default getPSBCFXRates;
