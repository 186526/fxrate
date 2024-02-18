import axios from 'axios';

import crypto from 'crypto';
import https from 'https';

import cheerio from 'cheerio';

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

const getBOCOMFXRates = async (): Promise<FXRate[]> => {
    const req = await axios.get(
        'http://www.bankcomm.com/SITE/queryExchangeResult.do',
        {
            ...allowLegacyRenegotiationforNodeJsOptions,
            headers: {
                'User-Agent': 'fxrate axios/latest',
            },
        },
    );

    const data = req.data['RSP_BODY'].fileContent;
    const $ = cheerio.load(
        '<table><tbody><tr class="bgcolorTable" tabindex="0">' +
            data +
            '</tr></tbody></table>',
    );
    const updatedTime = new Date(
        $('td[align="left"]').text().split('：')[1] + ' UTC+8',
    );

    return $('tr.data')
        .toArray()
        .map((el) => {
            const result: FXRate = {
                currency: {
                    from: $($(el).children()[0])
                        .text()
                        .split('(')[1]
                        .split('/')[0] as unknown as currency.unknown,
                    to: 'CNY' as currency.CNY,
                },
                rate: {
                    buy: {},
                    sell: {},
                },
                unit: parseInt($($(el).children()[1]).text()),
                updated: updatedTime,
            };

            if ($($(el).children()[2]).text() !== '-')
                result.rate.buy.remit = parseFloat(
                    $($(el).children()[2]).text(),
                );
            if ($($(el).children()[3]).text() !== '-')
                result.rate.sell.remit = parseFloat(
                    $($(el).children()[3]).text(),
                );
            if ($($(el).children()[4]).text() !== '-')
                result.rate.buy.cash = parseFloat(
                    $($(el).children()[4]).text(),
                );
            if ($($(el).children()[5]).text() !== '-')
                result.rate.sell.cash = parseFloat(
                    $($(el).children()[5]).text(),
                );

            return result;
        })
        .sort();
};

export default getBOCOMFXRates;
