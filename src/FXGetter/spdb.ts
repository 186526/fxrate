import axios from 'axios';

import cheerio from 'cheerio';

import { currency, FXRate } from 'src/types';

import crypto from 'crypto';
import https from 'https';
import { SPDBFXReqInfo } from './spdb.d';

/**
 * Handle this problem with Node 18
 * write EPROTO B8150000:error:0A000152:SSL routines:final_renegotiate:unsafe legacy renegotiation disabled
 * **/
const allowLegacyRenegotiationforNodeJsOptions = {
    httpsAgent: new https.Agent({
        // allow sb SPDB to use legacy renegotiation
        // 💩 SPDB
        secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
    }),
};

const getSPDBFXRates = async (): Promise<FXRate[]> => {
    const req = await axios.post(
        'https://www.spdb.com.cn/api/search',
        {
            metadata: 'NAME|ASK|BID|CODE|CREATE_DATE',
            size: 100,
            chlid: 1061,
            searchword: '',
        },
        {
            ...allowLegacyRenegotiationforNodeJsOptions,
            headers: {
                'User-Agent':
                    process.env['HEADER_USER_AGENT'] ?? 'fxrate axios/latest',
            },
        },
    );

    const data: SPDBFXReqInfo[] = req.data.data.content;

    return data
        .map((d) => {
            if (!d.CurrencyName) return null; // means that currency not visible globally (secret for SPDB)

            const fromCurrency = d.CurrencyName.split(' ')[1] as currency;

            return {
                currency: {
                    from: fromCurrency,
                    to: 'CNY' as currency.CNY,
                },

                rate: {
                    buy: {
                        cash: parseFloat(d.CashBuyPrc),
                        remit: parseFloat(d.BuyPrc),
                    },
                    sell: {
                        cash: parseFloat(d.CashSellPrc),
                        remit: parseFloat(d.SellPrc),
                    },
                    middle: parseFloat(d.MdlPrc),
                },

                updated: new Date(d['CREATE_DATE'] + ' UTC+8'),
                unit: parseInt(d.ExgRtUnt),
            } as FXRate;
        })
        .sort();
};

const getSPDBFXRatesByOldHTML = async (): Promise<FXRate[]> => {
    const req = await axios.get('https://www.spdb.com.cn/wh_pj/index.shtml', {
        ...allowLegacyRenegotiationforNodeJsOptions,
        headers: {
            'User-Agent':
                process.env['HEADER_USER_AGENT'] ?? 'fxrate axios/latest',
        },
    });

    console.log(req.data);

    const $ = cheerio.load(req.data);

    const updatedTime = new Date($('.fine_title > p').text() + ' UTC+8');

    return $('.table04 > tbody > tr')
        .toArray()
        .map((el) => {
            const toCurrency = $($(el).children()[0])
                .text()
                .split(' ')[1]
                .replace('\n', '') as currency;

            const result: FXRate = {
                currency: {
                    from: toCurrency,
                    to: 'CNY' as currency.CNY,
                },

                rate: {
                    buy: {
                        cash: parseFloat($($(el).children()[3]).text()),
                        remit: parseFloat($($(el).children()[2]).text()),
                    },
                    sell: {
                        cash: parseFloat($($(el).children()[4]).text()),
                        remit: parseFloat($($(el).children()[4]).text()),
                    },
                    middle: parseFloat($($(el).children()[1]).text()),
                },

                unit: toCurrency == 'JPY' ? 100000 : 100,
                updated: updatedTime,
            };
            return result;
        })
        .sort();
};

export default getSPDBFXRates;

export { getSPDBFXRatesByOldHTML };
