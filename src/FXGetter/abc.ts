import axios from 'axios';

import crypto from 'crypto';
import https from 'https';

import { currency, FXRate } from 'src/types';

/**
 * Handle this problem with Node 18
 * write EPROTO B8150000:error:0A000152:SSL routines:final_renegotiate:unsafe legacy renegotiation disabled
 **/
const allowLegacyRenegotiationforNodeJsOptions = {
    httpsAgent: new https.Agent({
        // allow sb ABC to use legacy renegotiation
        // 💩 ABC
        secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
    }),
};

const currencyMap = {
    '14': { name: 'USD' as currency.USD },
    '13': { name: 'HKD' as currency.HKD },
    '38': { name: 'EUR' as currency.EUR },
    '27': { name: 'JPY' as currency.JPY },
    '12': { name: 'GBP' as currency.GBP },
    '29': { name: 'AUD' as currency.AUD },
    '28': { name: 'CAD' as currency.CAD },
    '15': { name: 'CHF' as currency.CHF },
    '88': { name: 'KRW' as currency.KRW },
    '81': { name: 'MOP' as currency.MOP },
    '18': { name: 'SGD' as currency.SGD },
    '84': { name: 'THB' as currency.THB },
    '22': { name: 'DKK' as currency.DKK },
    '23': { name: 'NOK' as currency.NOK },
    '21': { name: 'SEK' as currency.SEK },
    '79': { name: 'TJS' as currency.TJS },
    '64': { name: 'VND' as currency.VND },
    '68': { name: 'KZT' as currency.KZT },
    '70': { name: 'RUB' as currency.RUB },
    '71': { name: 'ZAR' as currency.ZAR },
    '73': { name: 'MNT' as currency.MNT },
    '74': { name: 'LAK' as currency.LAK },
    '78': { name: 'AED' as currency.AED },
    '87': { name: 'NZD' as currency.NZD },
};

const getABCFXRates = async (): Promise<FXRate[]> => {
    const req = await axios.get(
        'https://ewealth.abchina.com/app/data/api/DataService/ExchangeRateV2',
        {
            ...allowLegacyRenegotiationforNodeJsOptions,
            headers: {
                'User-Agent':
                    process.env['HEADER_USER_AGENT'] ?? 'fxrate axios/latest',
            },
        },
    );

    const data = req.data.Data.Table;

    return data
        .map((d: any) => {
            return {
                currency: {
                    from: currencyMap[d.CurrId].name,
                    to: 'CNY' as currency.CNY,
                },
                rate: {
                    buy: {
                        remit: parseFloat(d.BuyingPrice),
                        cash: parseFloat(d.CashBuyingPrice),
                    },
                    sell: {
                        remit: parseFloat(d.SellPrice),
                        cash: parseFloat(d.SellPrice),
                    },
                    middle: parseFloat(d.BenchMarkPrice),
                },
                updated: new Date(d.PublishTime),
                unit: 100,
            } as FXRate;
        })
        .sort();
};

export default getABCFXRates;
