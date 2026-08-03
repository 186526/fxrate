import axios from 'axios';

import { FXRate, currency } from 'src/types.d';

interface CQCBankRate {
    ccy: string;
    bankMid: string;
    exchBid: string;
    exchOffer: string;
    cashBid: string;
    cashOffer: string;
    chargeNo: string;
    time: string;
}

const currencyMap: Record<string, currency> = {
    USDCNY: 'USD' as currency.USD,
    EURCNY: 'EUR' as currency.EUR,
    JPYCNY: 'JPY' as currency.JPY,
    HKDCNY: 'HKD' as currency.HKD,
    GBPCNY: 'GBP' as currency.GBP,
    AUDCNY: 'AUD' as currency.AUD,
    SGDCNY: 'SGD' as currency.SGD,
    CADCNY: 'CAD' as currency.CAD,
    MYRCNY: 'MYR' as currency.MYR,
    RUBCNY: 'RUB' as currency.RUB,
    THBCNY: 'THB' as currency.THB,
};

const parseUpdatedTime = (value: string): Date => {
    const updated = new Date(`${value.replace(' ', 'T')}+08:00`);
    return Number.isNaN(updated.getTime()) ? new Date() : updated;
};

const getBCQFXRates = async (): Promise<FXRate[]> => {
    const res = await axios.get(
        'https://www.cqcbank.com/cms/ExchangeRateQryInfo.do',
        {
            timeout: 10000,
            headers: {
                Accept: 'application/json, text/javascript, */*; q=0.01',
                Referer: 'https://www.cqcbank.com/',
                'User-Agent':
                    process.env['HEADER_USER_AGENT'] ??
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
                'X-Requested-With': 'XMLHttpRequest',
            },
        },
    );

    const rows = res.data?.rateMap?.List as CQCBankRate[] | undefined;
    if (!Array.isArray(rows)) {
        throw new Error(
            'CQCBank response format changed: rateMap.List is missing or not an array',
        );
    }

    return rows
        .map((row) => {
            const from = currencyMap[row.ccy];
            if (!from) return null;

            const middle = parseFloat(row.bankMid);
            const remitBuy = parseFloat(row.exchBid);
            const remitSell = parseFloat(row.exchOffer);
            const cashBuy = parseFloat(row.cashBid);
            const cashSell = parseFloat(row.cashOffer);
            const unit = parseFloat(row.chargeNo);
            if (
                [middle, remitBuy, remitSell, cashBuy, cashSell, unit].some(
                    (value) => !Number.isFinite(value),
                )
            ) {
                return null;
            }

            return {
                currency: {
                    from,
                    to: 'CNY' as currency.CNY,
                },
                rate: {
                    buy: {
                        remit: remitBuy,
                        cash: cashBuy,
                    },
                    sell: {
                        remit: remitSell,
                        cash: cashSell,
                    },
                    middle,
                },
                unit,
                updated: parseUpdatedTime(row.time),
            } as FXRate;
        })
        .filter((rate): rate is FXRate => rate !== null)
        .sort();
};

export default getBCQFXRates;
