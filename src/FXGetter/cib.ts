import axios from 'axios';
import { FXRate, currency } from 'src/types';
import cheerio from 'cheerio';

import crypto from 'crypto';
import https from 'https';

/**
 * Handle this problem with Node 18
 * write EPROTO B8150000:error:0A000152:SSL routines:final_renegotiate:unsafe legacy renegotiation disabled
 **/
const allowLegacyRenegotiationforNodeJsOptions = {
    httpsAgent: new https.Agent({
        // for self signed you could also add
        // rejectUnauthorized: false,
        // allow sb CIB to use legacy renegotiation
        // 💩 CIB
        secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
    }),
};

const getCIBFXRates = async (): Promise<FXRate[]> => {
    const resHTML = await axios.get(
        'https://personalbank.cib.com.cn/pers/main/pubinfo/ifxQuotationQuery.do',
        {
            ...allowLegacyRenegotiationforNodeJsOptions,
            headers: {
                'User-Agent': 'fxrate axios/latest',
            },
        },
    );

    const res = await axios.get(
        `https://personalbank.cib.com.cn/pers/main/pubinfo/ifxQuotationQuery/list?_search=false&dataSet.nd=${Date.now()}&dataSet.rows=80&dataSet.page=1&dataSet.sidx=&dataSet.sord=asc`,
        {
            ...allowLegacyRenegotiationforNodeJsOptions,
            headers: {
                'User-Agent': 'fxrate axios/latest',
                Cookie: resHTML.headers['set-cookie']
                    .map((cookie) => cookie.split(';')[0])
                    .join('; '),
            },
        },
    );

    const FXRates: FXRate[] = [];

    if (res.status != 200 || resHTML.status != 200)
        throw new Error(`Get CIB FX Rates failed.`);

    const $ = cheerio.load(resHTML.data);

    const updateTime = new Date(
        $($('.labe_text')[0])
            .text()
            .replaceAll('\n\t', '')
            .replaceAll('  ', '')
            .replaceAll('日期： ', '')
            .replaceAll('年', '-')
            .replaceAll('月', '-')
            .replaceAll('日', '')
            .split(' ')
            .filter((_, i) => i != 1)
            .join(' ') + ' UTC+8',
    );

    res.data.rows.forEach((row) => {
        row = row.cell;
        const FXRate = {
            currency: {
                from: row[1] as currency.unknown,
                to: 'CNY' as currency.CNY,
            },
            unit: parseFloat(row[2]) as number,
            updated: updateTime,
            rate: {
                buy: {
                    remit: parseFloat(row[3]) as number,
                    cash: parseFloat(row[5]) as number,
                },
                sell: {
                    remit: parseFloat(row[4]) as number,
                    cash: parseFloat(row[6]) as number,
                },
                middle: undefined as number,
            },
        };
        FXRate.rate.middle =
            (FXRate.rate.buy.remit +
                FXRate.rate.sell.remit +
                FXRate.rate.buy.cash +
                FXRate.rate.sell.cash) /
            4;
        FXRates.push(FXRate);
    });

    return FXRates;
};

const getCIBHuanyuFXRates = async (): Promise<FXRate[]> => {
    const origin = await getCIBFXRates();
    return origin.map((rate) => {
        const originRate = rate.rate;
        rate.rate.buy.cash =
            Number(originRate.buy.cash) * 0.75 +
            Number(originRate.sell.cash) * 0.25;
        rate.rate.buy.remit =
            Number(originRate.buy.remit) * 0.75 +
            Number(originRate.sell.remit) * 0.25;
        rate.rate.sell.cash =
            Number(originRate.sell.cash) * 0.75 +
            Number(originRate.buy.cash) * 0.25;
        rate.rate.sell.remit =
            Number(originRate.sell.remit) * 0.75 +
            Number(originRate.buy.remit) * 0.25;
        return rate;
    });
};

export default getCIBFXRates;
export { getCIBHuanyuFXRates };
