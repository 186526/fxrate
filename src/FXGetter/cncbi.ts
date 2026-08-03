import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';
import { FXRate, currency } from 'src/types.d';

interface CNCBIExchangeRateInfo {
    askExchangeRate?: number | string;
    bidExchangeRate?: number | string;
    currencyCode?: string;
}

interface CNCBIResponse {
    TE01?: {
        dateOfEnquiry?: number | string;
        exchangeRateInfo?: CNCBIExchangeRateInfo | CNCBIExchangeRateInfo[];
        timeOfEnquiry?: number | string;
    };
}

const parser = new XMLParser();

const currencyMap: Record<string, currency> = {
    AUD: 'AUD' as currency.AUD,
    CAD: 'CAD' as currency.CAD,
    CHF: 'CHF' as currency.CHF,
    CNY: 'CNY' as currency.CNY,
    EUR: 'EUR' as currency.EUR,
    GBP: 'GBP' as currency.GBP,
    INR: 'INR' as currency.INR,
    JPY: 'JPY' as currency.JPY,
    KRW: 'KRW' as currency.KRW,
    MYR: 'MYR' as currency.MYR,
    NOK: 'NOK' as currency.NOK,
    NZD: 'NZD' as currency.NZD,
    PHP: 'PHP' as currency.PHP,
    SEK: 'SEK' as currency.SEK,
    SGD: 'SGD' as currency.SGD,
    THB: 'THB' as currency.THB,
    TWD: 'TWD' as currency.TWD,
    USD: 'USD' as currency.USD,
};

const parseUpdated = (
    dateOfEnquiry?: number | string,
    timeOfEnquiry?: number | string,
): Date => {
    const date = String(dateOfEnquiry ?? '');
    const time = String(timeOfEnquiry ?? '').padStart(6, '0');
    if (!/^\d{8}$/.test(date) || !/^\d{6}$/.test(time)) {
        return new Date();
    }

    const updated = new Date(
        `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` +
            `T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}+08:00`,
    );
    return Number.isNaN(updated.getTime()) ? new Date() : updated;
};

const getCNCBIFXRates = async (): Promise<FXRate[]> => {
    const res = await axios.get(
        'https://www.cncbinternational.com/rate-table/xml/TE01.xml',
        {
            timeout: 10000,
            headers: {
                'User-Agent':
                    process.env['HEADER_USER_AGENT'] ?? 'fxrate axios/latest',
            },
        },
    );
    const data = (parser.parse(res.data) as CNCBIResponse).TE01;
    if (!data) return [];

    const rows = Array.isArray(data.exchangeRateInfo)
        ? data.exchangeRateInfo
        : data.exchangeRateInfo
          ? [data.exchangeRateInfo]
          : [];
    const updated = parseUpdated(data.dateOfEnquiry, data.timeOfEnquiry);

    return rows
        .map((row): FXRate | null => {
            const from = row.currencyCode
                ? currencyMap[row.currencyCode]
                : undefined;
            const buy = Number(row.bidExchangeRate);
            const sell = Number(row.askExchangeRate);
            if (
                !from ||
                !Number.isFinite(buy) ||
                !Number.isFinite(sell) ||
                buy <= 0 ||
                buy >= sell
            ) {
                return null;
            }

            return {
                currency: {
                    from,
                    to: 'HKD' as currency.HKD,
                },
                rate: {
                    buy: { remit: buy },
                    sell: { remit: sell },
                    middle: (buy + sell) / 2,
                },
                // JPY/KRW are quoted around 0.05/0.005 HKD, confirming per-unit rates.
                unit: 1,
                updated,
            };
        })
        .filter((rate): rate is FXRate => rate !== null)
        .sort();
};

export default getCNCBIFXRates;
