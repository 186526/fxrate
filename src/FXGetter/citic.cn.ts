import axios from 'axios';
import { currency, FXRate } from 'src/types';

interface citicBankResponse {
    quotePriceDate: string;
    quotePriceTime: string;

    curName: string;
    curCode: string;

    totalPidPrice: string;
    totalSellPrice: string;

    cstexcBuyPrice: string;
    cstexcSellPrice: string;

    cstpurBuyPrice: string;
    cstpurSellPrice: string;

    midPrice: string;
}

const currencyMap = {
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
            headers: {
                'User-Agent': 'fxrate axios/latest',
            },
        },
    );

    const data: citicBankResponse[] = JSON.parse([eval][0](req.data)).content
        .resultList;

    const answer: FXRate[] = [];

    data.forEach((k) => {
        if (!Object.keys(currencyMap).includes(k.curCode)) {
            return;
        }

        answer.push({
            currency: {
                from: currencyMap[k.curCode] as currency.unknown,
                to: 'CNY' as currency.CNY,
            },
            rate: {
                buy: {
                    remit: parseFloat(k.cstexcBuyPrice),
                    cash: parseFloat(k.cstpurBuyPrice),
                },
                sell: {
                    cash: parseFloat(k.cstpurSellPrice),
                    remit: parseFloat(k.cstexcSellPrice),
                },
                middle: parseFloat(k.midPrice),
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
