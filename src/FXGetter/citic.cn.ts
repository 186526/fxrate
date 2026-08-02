import axios from 'axios';
import { currency, FXRate } from 'src/types.d';

interface citicBankResponse {
    quotePriceDate: string;
    quotePriceTime: string;

    curName: string;
    curCode: string;

    // 2026-08 实测：API 仅返回以下两个价格字段，无现金价（cstpur*）与中间价（midPrice）。
    cstexcBuyPrice: string;
    cstexcSellPrice: string;
}

const currencyMap: Record<string, currency> = {
    '027001': 'JPY' as currency.JPY,
    '012001': 'GBP' as currency.GBP,
    '023001': 'NOK' as currency.NOK,
    '051001': 'EUR' as currency.EUR,
    '014001': 'USD' as currency.USD,
    '028001': 'CAD' as currency.CAD,
    '032001': 'MYR' as currency.MYR,
    '038001': 'THB' as currency.THB,
    '081001': 'MOP' as currency.MOP,
    '018001': 'SGD' as currency.SGD,
    '065001': 'SAR' as currency.SAR,
    '021001': 'SEK' as currency.SEK,
    '015001': 'CHF' as currency.CHF,
    '062001': 'NZD' as currency.NZD,
    '029001': 'AUD' as currency.AUD,
    '022001': 'DKK' as currency.DKK,
    '031001': 'KZT' as currency.KZT,
    '013001': 'HKD' as currency.HKD,
};

const getCITICCNFXRates = async (): Promise<FXRate[]> => {
    const req = await axios.get(
        `https://etrade.citicbank.com/portalweb/cms/getForeignExchRate.htm?callback=JSON.stringify`,
        {
            timeout: 10000,
            headers: {
                'User-Agent':
                    process.env['HEADER_USER_AGENT'] ?? 'fxrate axios/latest',
            },
        },
    );

    // Response is JSONP wrapped (callback=JSON.stringify): `JSON.stringify({...})`.
    // Unwrap the object literal between the first '(' and the last ')' before parsing.
    const jsonpData = req.data.replace(/^[^(]*\(/, '').replace(/\)\s*$/, '');
    const data: citicBankResponse[] = JSON.parse(jsonpData).content.resultList;

    const answer: FXRate[] = [];

    data.forEach((k) => {
        if (!Object.keys(currencyMap).includes(k.curCode)) {
            return;
        }

        const buyPrice = parseFloat(k.cstexcBuyPrice);
        const sellPrice = parseFloat(k.cstexcSellPrice);

        answer.push({
            currency: {
                from: currencyMap[k.curCode] as currency.unknown,
                to: 'CNY' as currency.CNY,
            },
            rate: {
                buy: {
                    remit: buyPrice,
                    cash: buyPrice,
                },
                sell: {
                    cash: sellPrice,
                    remit: sellPrice,
                },
                // API 不返回 midPrice 字段（2026-08 实测），用买卖均价估算中间价。
                middle:
                    Number.isFinite(buyPrice) && Number.isFinite(sellPrice)
                        ? (buyPrice + sellPrice) / 2
                        : NaN,
            },
            unit: 100,
            updated: new Date(
                `${k.quotePriceDate.replace('年', '-').replace('月', '-').replace('日', '')} ${k.quotePriceTime} UTC+8`,
            ),
        });
    });

    return answer.sort();
};

export default getCITICCNFXRates;
