import axios from 'axios';
import { FXRate, currency } from 'src/types';
import cheerio from 'cheerio';

const currencyMap = {
    美元: 'USD',
    欧元: 'EUR',
    日元: 'JPY',
    港元: 'HKD',
    英镑: 'GBP',
    澳元: 'AUD',
    新西兰元: 'NZD',
    新加坡元: 'SGD',
    瑞士法郎: 'CHF',
    加元: 'CAD',
    澳门元: 'MOP',
    林吉特: 'MYR',
    卢布: 'RUB',
    兰特: 'ZAR',
    韩元: 'KRW',
    迪拉姆: 'AED',
    里亚尔: 'SAR',
    福林: 'HUF',
    兹罗提: 'PLN',
    丹麦克朗: 'DKK',
    瑞典克朗: 'SEK',
    挪威克朗: 'NOK',
    里拉: 'TRY',
    比索: 'MXN',
    泰铢: 'THB',
};

const undirectPrice: currency[] = [
    'MOP' as currency.MOP,
    'MYR' as currency.MYR,
    'RUB' as currency.RUB,
    'ZAR' as currency.ZAR,
    'KRW' as currency.KRW,
    'AED' as currency.AED,
    'SAR' as currency.SAR,
    'HUF' as currency.HUF,
    'PLN' as currency.PLN,
    'DKK' as currency.DKK,
    'SEK' as currency.SEK,
    'NOK' as currency.NOK,
    'TRY' as currency.TRY,
    'MXN' as currency.MXN,
    'THB' as currency.THB,
];

const getPBOCFXRates = async (): Promise<FXRate[]> => {
    const res = await axios.get(
        'http://www.safe.gov.cn/AppStructured/hlw/RMBQuery.do',
        {
            headers: {
                'User-Agent':
                    process.env['HEADER_USER_AGENT'] ?? 'fxrate axios/latest',
            },
        },
    );

    const $ = cheerio.load(res.data);
    const table = $('table#InfoTable').children()[0];

    return table.children
        .slice(1)
        .map((el) => {
            const row = $(el);

            const updateTime = new Date(
                $(row.children()[0]).text() + ' 00:00 UTC+8',
            );

            return row
                .children()
                .slice(1)
                .toArray()
                .map((thisEL, index): FXRate => {
                    const anz = {
                        currency: {
                            from: 'unknown' as unknown as currency,
                            to: 'unknown' as unknown as currency,
                        },
                        rate: {
                            middle: parseFloat($(thisEL).text()),
                        },
                        updated: updateTime,
                        unit: 100,
                    };

                    const currencyZHName = $(
                        $(table.children[0]).children()[index + 1],
                    )
                        .text()
                        .trim();

                    if (undirectPrice.includes(currencyMap[currencyZHName])) {
                        anz.currency = {
                            from: 'CNY' as currency.CNY,
                            to: currencyMap[currencyZHName] as currency.unknown,
                        };
                    } else {
                        anz.currency = {
                            from: currencyMap[
                                currencyZHName
                            ] as currency.unknown,
                            to: 'CNY' as currency.CNY,
                        };
                    }
                    return anz;
                });
        })
        .flat()
        .sort();
};

export default getPBOCFXRates;
