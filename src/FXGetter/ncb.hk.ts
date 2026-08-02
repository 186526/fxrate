import axios from 'axios';

import { FXRate, currency } from 'src/types.d';

interface ncbHkRateItem {
    currency: string;
    outNum: number;
    inNum: number;
    createTime: string;
}

const currencyMapping: Record<string, currency> = {
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

const CURRENCIES_QUOTED_AS_HKD_BASE: currency[] = [
    'CNY' as currency.CNY,
    'CNH' as currency.CNH,
];

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
        { timeout: 10000 },
    );

    return res.data.data.resultList
        .map((fx: ncbHkRateItem) => {
            const currencyName = currencyMapping[fx.currency];
            if (!currencyName) return null;

            // 绝大多数货币：inNum/outNum = 「100 外币 = X HKD」（1 USD = 7.8274 HKD，实测验证）。
            // 但 CNY/CNH 特殊：报价是「100 HKD = X CNY」（1 HKD = 0.8671 CNY，交叉验证 1 USD = 6.76 CNY 吻合市场），
            // 方向与其他货币相反，必须反转。inNum=银行买入价、outNum=银行卖出价；
            // 离岸人民币的买入价可能高于卖出价，不能按 min/max 推断买卖方向。
            // JPY 特殊：按「10000 日元 = X HKD」报价（1 JPY = 0.0490 HKD，交叉验证与 hsbc.hk 一致）。
            const buy = Number(fx.inNum);
            const sell = Number(fx.outNum);
            const hkdBase =
                CURRENCIES_QUOTED_AS_HKD_BASE.includes(currencyName);
            const unit = currencyName === ('JPY' as currency.JPY) ? 10000 : 100;

            return {
                currency: hkdBase
                    ? {
                          from: 'HKD' as currency.HKD,
                          to: currencyName as unknown as currency.unknown,
                      }
                    : {
                          from: currencyName as unknown as currency.unknown,
                          to: 'HKD' as currency.HKD,
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
                unit: unit,
                updated: new Date(fx.createTime + ' UTC+8'),
            };
        })
        .filter((fx): fx is FXRate => fx !== null)
        .sort();
};

export default getNCBHKFXRates;
