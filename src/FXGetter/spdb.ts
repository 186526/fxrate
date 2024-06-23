import axios from 'axios';

import cheerio from 'cheerio';

import { currency, FXRate } from 'src/types';

const getSPDBFXRates = async (): Promise<FXRate[]> => {
    const req = await axios.get(
        'https://www.spdb.com.cn/was5/web/search?channelid=256931',
        {
            headers: {
                'User-Agent': 'fxrate axios/latest',
            },
        },
    );

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
