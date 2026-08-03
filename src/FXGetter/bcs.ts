import axios from 'axios';

import { FXRate, currency } from 'src/types.d';

interface BCSCRate {
    buyPrice: string;
    curSign: string;
    impDate: string;
    middlePrice: string;
    salePrice: string;
    billbuyPrice: string;
    billsalePrice: string;
}

const currencyMap: Record<string, currency> = {
    JPY: 'JPY' as currency.JPY,
    HKD: 'HKD' as currency.HKD,
    CAD: 'CAD' as currency.CAD,
    GBP: 'GBP' as currency.GBP,
    EUR: 'EUR' as currency.EUR,
    USD: 'USD' as currency.USD,
    AUD: 'AUD' as currency.AUD,
};

const parseUpdatedTime = (value: string): Date => {
    const updated = new Date(`${value.replace(' ', 'T')}+08:00`);
    return Number.isNaN(updated.getTime()) ? new Date() : updated;
};

const getBCSFXRates = async (): Promise<FXRate[]> => {
    const res = await axios.get(
        'http://www.bankofchangsha.com.cn/ajax/list_new_whpj',
        {
            timeout: 10000,
            headers: {
                Accept: 'application/json, text/javascript, */*; q=0.01',
                'User-Agent':
                    process.env['HEADER_USER_AGENT'] ?? 'fxrate axios/latest',
                'X-Requested-With': 'XMLHttpRequest',
            },
        },
    );

    const rows = res.data?.info as BCSCRate[] | undefined;
    if (!Array.isArray(rows)) {
        throw new Error(
            'BCSC response format changed: info is missing or not an array',
        );
    }

    return rows
        .map((row) => {
            const from = currencyMap[row.curSign];
            if (!from) return null;

            const middle = parseFloat(row.middlePrice);
            const remitBuy = parseFloat(row.buyPrice);
            const remitSell = parseFloat(row.salePrice);
            const cashBuy = parseFloat(row.billbuyPrice);
            const cashSell = parseFloat(row.billsalePrice);
            if (
                [middle, remitBuy, remitSell, cashBuy, cashSell].some(
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
                unit: 100,
                updated: parseUpdatedTime(row.impDate),
            } as FXRate;
        })
        .filter((rate): rate is FXRate => rate !== null)
        .sort();
};

export default getBCSFXRates;
