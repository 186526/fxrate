import axios from 'axios';
import { FXRate, currency } from 'src/types';

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

    return data
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
                updated: new Date(
                    ((date: number, time: number) => {
                        const dateStringArray = date.toString().split('');
                        const timeStringArray = time.toString().split('');
                        dateStringArray.splice(4, 0, '-');
                        dateStringArray.splice(7, 0, '-');
                        timeStringArray.splice(2, 0, ':');
                        timeStringArray.splice(5, 0, ':');
                        return `${dateStringArray.join('')} ${timeStringArray.join('')} UTC+8`;
                    })(fx.effect_date, fx.effect_time),
                ),
            } as FXRate;
        })
        .sort();
};

export default getPSBCFXRates;
