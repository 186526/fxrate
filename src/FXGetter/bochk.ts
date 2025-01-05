import axios from 'axios';
import cheerio from 'cheerio';

import { currency, FXRate } from 'src/types.d';

const currencyMapping = {
    '人民幣(在岸)': currency.CNY,
    人民幣: currency.CNY,
    '人民幣(離岸)': currency.CNH,
    美元: currency.USD,
    英鎊: currency.GBP,
    日圓: currency.JPY,
    澳元: currency.AUD,
    紐元: currency.NZD,
    加元: currency.CAD,
    歐羅: currency.EUR,
    瑞士法郎: currency.CHF,
    丹麥克郎: currency.DKK,
    挪威克郎: currency.NOK,
    瑞典克郎: currency.SEK,
    新加坡元: currency.SGD,
    泰國銖: currency.THB,
    文萊元: currency.BND,
    南非蘭特: currency.ZAR,
    印尼盾: currency.IDR,
    紐西蘭元: currency.NZD,
    加拿大元: currency.CAD,
    印度盧比: currency.INR,
    韓國圜: currency.KRW,
    澳門元: currency.MOP,
    菲律賓彼索: currency.PHP,
    俄羅斯盧布: currency.RUB,
    新台幣: currency.TWD,
};

const getBOCHKFxRatesBasis = async (
    link: string,
): Promise<{
    [currency: string]: {
        buy: number;
        sell: number;
        updatedDate: Date;
    };
}> => {
    const answer = {};

    const res = await axios.get(link, {
        headers: {
            'User-Agent':
                process.env['HEADER_USER_AGENT'] ?? 'fxrate axios/latest',
        },
    });

    const $ = cheerio.load(res.data);
    const updatedDate = new Date(
        $($('div.form_area table tbody tr').toArray().at(-2))
            .text()
            .trim()
            .split('：')[1]
            .replaceAll('\n', '')
            .replaceAll('\t', '') + ' UTC+8',
    );

    Array.from(
        new Set(
            $('div.form_area table tbody tr')
                .slice(2)
                .slice(0, -2)
                .toArray()
                .map((el) => {
                    const e = $(el);
                    const zhName = e.find('td:nth-child(1)').text().trim();

                    if (!currencyMapping[zhName]) {
                        console.error('Unknown currency:', zhName);
                    }

                    const enName = currencyMapping[zhName] || 'unknown';

                    const Buy = e.find('td:nth-child(2)').text().trim();
                    const Sell = e.find('td:nth-child(3)').text().trim();

                    answer[enName] = {
                        buy: parseFloat(Buy),
                        sell: parseFloat(Sell),
                        updatedDate,
                    };
                }),
        ),
    );

    return answer;
};

export const getBOCHKFxRatesRemit = () =>
    getBOCHKFxRatesBasis(
        `https://www.bochk.com/whk/rates/exchangeRatesHKD/exchangeRatesHKD-input.action?lang=hk`,
    );
export const getBOCHKFxRatesCash = () =>
    getBOCHKFxRatesBasis(
        `https://www.bochk.com/whk/rates/exchangeRatesForCurrency/exchangeRatesForCurrency-input.action?lang=hk`,
    );

export const getBOCHKFxRates = async (): Promise<FXRate[]> => {
    const result = await Promise.all([
        getBOCHKFxRatesCash(),
        getBOCHKFxRatesRemit(),
    ]);

    const currencyList = Array.from(
        new Set(
            result
                .map((k) => {
                    return Object.keys(k);
                })
                .flat(),
        ),
    );

    return currencyList
        .map((k): FXRate => {
            const cash = result[0][k];
            const remit = result[1][k];

            let updatedTime = new Date();

            if (cash) updatedTime = cash.updatedDate;
            if (remit) updatedTime = remit.updatedDate;
            if (cash && remit)
                updatedTime =
                    cash.updatedDate > remit.updatedDate
                        ? cash.updatedDate
                        : remit.updatedDate;

            const answer: FXRate = {
                currency: {
                    from: k as unknown as currency.unknown,
                    to: 'HKD' as currency.HKD,
                },
                updated: updatedTime,
                rate: {
                    buy: {},
                    sell: {},
                },
                unit: 1,
            };

            if (cash) {
                answer.rate.buy.cash = cash.buy;
                answer.rate.sell.cash = cash.sell;
            }

            if (remit) {
                answer.rate.buy.remit = remit.buy;
                answer.rate.sell.remit = remit.sell;
            }

            return answer;
        })
        .sort();
};

export default getBOCHKFxRates;
