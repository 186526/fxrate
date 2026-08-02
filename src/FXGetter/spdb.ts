import axios from 'axios';

import * as cheerio from 'cheerio';

import { currency, FXRate } from 'src/types.d';

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
            timeout: 10000,
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

            // CurrencyName looks like '美元 USD' — take the code after the space.
            const fromCurrency = d.CurrencyName.split(' ')[1] as currency;
            if (!fromCurrency) return null;

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
        .filter((d): d is FXRate => d !== null);
};

const getSPDBFXRatesByOldHTML = async (): Promise<FXRate[]> => {
    const req = await axios.get('https://www.spdb.com.cn/wh_pj/index.shtml', {
        ...allowLegacyRenegotiationforNodeJsOptions,
        timeout: 10000,
        headers: {
            'User-Agent':
                process.env['HEADER_USER_AGENT'] ?? 'fxrate axios/latest',
        },
    });

    const $ = cheerio.load(req.data);

    const updatedTime = new Date($('.fine_title > p').text() + ' UTC+8');

    return $('.table04 > tbody > tr')
        .toArray()
        .map((el) => {
            // first cell looks like '美元 USD' — take the code after the space.
            const currencyName = $($(el).children()[0]).text();
            const toCurrency = currencyName
                .split(' ')[1]
                ?.replace('\n', '') as currency;
            if (!toCurrency) return null;

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
                        // The current SPDB page has a single 卖出价 column
                        // (children[4]); cash and remit share the same offer.
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
        .filter((d): d is FXRate => d !== null);
};

export default getSPDBFXRates;

export { getSPDBFXRatesByOldHTML };
