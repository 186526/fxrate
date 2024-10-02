import axios from 'axios';

import { FXRate, currency } from 'src/types';

export interface PABResponse {
    data: {
        count: number; // length of exchangeList
        exchangeList: {
            basePrice: number; // 100 unit of foreign currency middle rate to CNY
            buyPrice: number; // 100 unit of foreign currency buy rate to CNY
            cashBuyPrice: number; // 100 unit of foreign currency cash buy rate to CNY
            currName: string; // like '美元'
            currType: currency; // like 'USD'
            exchangeDate: string; // like '2021-08-17'
            insertTime: string; // like '2021-08-17 10:00:00'
            movePrice: number; // unknown
            payPrice: number; // unknown
            rmbRate: number; // unknown
            sellPrice: number; // 100 unit of foreign currency sell rate to CNY
            usdRate: 0; // unknown
        }[];
    };
    responseCode: string; // like 000000, 6 digits
    responseMsg: string; // like '成功'
}

const getPABFXRates = async (): Promise<FXRate[]> => {
    const req = await axios.get(
        'https://bank.pingan.com.cn/rmb/account/cmp/cust/acct/forex/exchange/qryFoexPriceExchangeList.do?pageIndex=1&pageSize=100&realFlag=1&currencyCode=&exchangeDate=&languageCode=zh_CN&access_source=PC',
        {
            headers: {
                'User-Agent':
                    process.env['HEADER_USER_AGENT'] ?? 'fxrate axios/latest',
            },
        },
    );

    const data: PABResponse = req.data;

    return data.data.exchangeList
        .map((rate) => {
            return {
                currency: {
                    from: rate.currType,
                    to: 'CNY' as currency.CNY,
                },
                rate: {
                    buy: {
                        cash: rate.cashBuyPrice,
                        remit: rate.buyPrice,
                    },
                    sell: {
                        cash: rate.sellPrice,
                        remit: rate.sellPrice,
                    },
                    middle: rate.basePrice,
                },
                unit: 100,
                updated: new Date(rate.insertTime + ' GMT+0800'),
            } as FXRate;
        })
        .sort();
};

export default getPABFXRates;
