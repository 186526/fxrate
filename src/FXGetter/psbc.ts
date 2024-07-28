import axios from 'axios';
import { FXRate, currency } from 'src/types';
import { parseYYYYMMDDHHmmss } from './ncb.cn';

import https from 'https';

const allowPSBCCertificateforNodeJsOptions = {
    httpsAgent: new https.Agent({
        // dont vertify sb PSBC SSL Certificate (becuz they don't send full certificate chain now!!!)
        // 💩 PSBC
        rejectUnauthorized: false,
    }),
};

const getPSBCFXRates = async () => {
    const res = await axios.get(
        'https://s.psbc.com/portal/PsbcService/foreignexchange/curr',
        {
            ...allowPSBCCertificateforNodeJsOptions,
            headers: {
                'User-Agent': 'fxrate axios/latest',
            },
        },
    );

    const data = JSON.parse(
        res.data.replaceAll('empty(', '').replaceAll(')', ''),
    ).resultList;

    const answer = data
        .filter((k) => k.flag == 2)
        .map((fx) => {
            return {
                currency: {
                    from: fx.cur as currency.unknown,
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
