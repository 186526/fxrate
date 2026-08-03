import { randomUUID } from 'node:crypto';

import axios from 'axios';
import { FXRate, currency } from 'src/types.d';

interface OCBCHKRateItem {
    ccyFrom: string;
    ccyTo: string;
    bidRate: string | number;
    askRate: string | number;
    unit: string | number;
    lastUpdateDatetime?: string;
}

interface OCBCHKResponse {
    data?: OCBCHKRateItem[];
}

const currencyMapping: Record<string, currency> = {
    GBP: 'GBP' as currency.GBP,
    SEK: 'SEK' as currency.SEK,
    NZD: 'NZD' as currency.NZD,
    EUR: 'EUR' as currency.EUR,
    AUD: 'AUD' as currency.AUD,
    CAD: 'CAD' as currency.CAD,
    CNY: 'CNY' as currency.CNY,
    MOP: 'MOP' as currency.MOP,
    NOK: 'NOK' as currency.NOK,
    THB: 'THB' as currency.THB,
    SGD: 'SGD' as currency.SGD,
    USD: 'USD' as currency.USD,
    DKK: 'DKK' as currency.DKK,
    CNH: 'CNH' as currency.CNH,
    JPY: 'JPY' as currency.JPY,
    CHF: 'CHF' as currency.CHF,
    HKD: 'HKD' as currency.HKD,
};

const formatHongKongDateTime = (date = new Date()): string =>
    new Date(date.getTime() + 8 * 60 * 60 * 1000)
        .toISOString()
        .replace('Z', '+08:00');

const parseDate = (value?: string): Date => {
    if (!value) return new Date();
    // The API labels its Hong Kong wall-clock value with Z; use the observed +08:00 zone.
    const date = new Date(value.replace(/Z$/, '+08:00'));
    return Number.isFinite(date.getTime()) ? date : new Date();
};

const getOCBCHKFXRates = async (): Promise<FXRate[]> => {
    const res = await axios.post<OCBCHKResponse>(
        'https://ebanking.ocbc.com.hk/digital/api/fx-hk/v1/public/fx-rate/inquiry',
        {
            currencyCodes: [],
            pageSize: 50,
            pageIdx: 1,
            baseCurrency: 'HKD',
            rateType: 'I',
        },
        {
            timeout: 10000,
            headers: {
                'User-Agent':
                    process.env['HEADER_USER_AGENT'] ??
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
                'x-correlation-id': randomUUID(),
                'x-source-country': 'HK',
                'x-source-date-time': formatHongKongDateTime(),
                'x-source-id': 'IWPG',
                'x-lang-id': 'en_US',
            },
        },
    );

    if (!Array.isArray(res.data.data)) {
        throw new Error('OCBC Hong Kong returned an invalid response');
    }

    const rates: FXRate[] = [];
    for (const row of res.data.data) {
        const from = currencyMapping[row.ccyFrom];
        const to = currencyMapping[row.ccyTo];
        const buy = Number(row.bidRate);
        const sell = Number(row.askRate);
        const unit = Number(row.unit);
        if (
            !from ||
            !to ||
            from === to ||
            !Number.isFinite(buy) ||
            !Number.isFinite(sell) ||
            !Number.isFinite(unit) ||
            buy <= 0 ||
            sell <= 0 ||
            unit <= 0 ||
            buy >= sell
        ) {
            continue;
        }

        rates.push({
            currency: { from, to },
            rate: {
                buy: { remit: buy },
                sell: { remit: sell },
                middle: (buy + sell) / 2,
            },
            unit,
            updated: parseDate(row.lastUpdateDatetime),
        });
    }

    if (rates.length === 0) {
        throw new Error('OCBC Hong Kong returned no rates');
    }
    return rates.sort();
};

export default getOCBCHKFXRates;
