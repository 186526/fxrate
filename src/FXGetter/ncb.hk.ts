import axios from 'axios';

import { FXRate, currency } from 'src/types';

const currencyMapping = {
    '156': 'CNY' as currency.CNY,
    A04: 'CNH' as currency.CNH,
    '840': 'USD' as currency.USD,
    '826': 'GBP' as currency.GBP,
    '392': 'JPY' as currency.JPY,
    '036': 'AUD' as currency.AUD,
    '554': 'NZD' as currency.NZD,
    '124': 'CAD' as currency.CAD,
    '978': 'EUR' as currency.EUR,
    '756': 'CHF' as currency.CHF,
    '208': 'DKK' as currency.DKK,
    '578': 'NOK' as currency.NOK,
    '752': 'SEK' as currency.SEK,
    '702': 'SGD' as currency.SGD,
    '764': 'THB' as currency.THB,
};

const getNCBHKFXRates = async (): Promise<FXRate[]> => {
    const res = await axios.post(
        'https://www.ncb.com.hk/api/precious/findConversionRateAll',
        {
            headers: {
                language: 'en',
                'User-Agent':
                    process.env['HEADER_USER_AGENT'] ?? 'fxrate axios/latest',
            },
            body: {
                language: 3,
                custType: 1,
            },
        },
    );

    return res.data.data.resultList
        .map((fx) => {
            const currencyName = currencyMapping[fx.currency];

            const buy = fx.outNum < fx.inNum ? fx.outNum : fx.inNum;
            const sell = fx.outNum < fx.inNum ? fx.inNum : fx.outNum;

            return {
                currency: {
                    to: currencyName as unknown as currency.unknown,
                    from: 'HKD' as currency.HKD,
                },
                rate: {
                    buy: {
                        remit: buy,
                        cash: buy,
                    },
                    sell: {
                        remit: sell,
                        cash: sell,
                    },
                },
                unit: 100,
                updated: new Date(fx.createTime + ' UTC+8'),
            };
        })
        .sort();
};

export default getNCBHKFXRates;
