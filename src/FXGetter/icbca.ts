import { constants } from 'node:crypto';
import https from 'node:https';

import axios from 'axios';
import { FXRate, currency } from 'src/types.d';

interface ICBCARateItem {
    currename: string;
    buyrate: string | number;
    salrate: string | number;
    updateTime?: string;
}

interface ICBCAResponse {
    code: number;
    data?: ICBCARateItem[];
}

const currencyMapping: Record<string, currency> = {
    AUD: 'AUD' as currency.AUD,
    CAD: 'CAD' as currency.CAD,
    GBP: 'GBP' as currency.GBP,
    EUR: 'EUR' as currency.EUR,
    SGD: 'SGD' as currency.SGD,
    CHF: 'CHF' as currency.CHF,
    USD: 'USD' as currency.USD,
    NZD: 'NZD' as currency.NZD,
    JPY: 'JPY' as currency.JPY,
    CNY: 'CNY' as currency.CNY,
};

const parseCurrency = (
    value: string,
): { from: currency; unit: number } | undefined => {
    const match = /^([A-Z]{3})(?:\((\d+)\s+Units?\))?$/.exec(value.trim());
    if (!match) return undefined;

    const from = currencyMapping[match[1]];
    const unit = match[2] ? Number(match[2]) : 1;
    if (!from || !Number.isSafeInteger(unit) || unit <= 0) return undefined;
    return { from, unit };
};

const parseDate = (value?: string): Date => {
    if (!value) return new Date();
    const normalized = value
        .trim()
        .replace(' ', 'T')
        .replace(/(\.\d{3})\d+$/, '$1');
    const date = new Date(`${normalized}+08:00`);
    return Number.isFinite(date.getTime()) ? date : new Date();
};

const getICBCAFXRates = async (): Promise<FXRate[]> => {
    const httpsAgent = new https.Agent({
        secureOptions: constants.SSL_OP_LEGACY_SERVER_CONNECT,
    });
    const res = await axios.get<ICBCAResponse>(
        'https://papi.icbc.com.cn/rest/currencies/asia/foreign',
        {
            httpsAgent,
            timeout: 30000,
            headers: {
                'User-Agent':
                    process.env['HEADER_USER_AGENT'] ??
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
            },
        },
    );

    if (res.data.code !== 0 || !Array.isArray(res.data.data)) {
        throw new Error('ICBC Asia returned an invalid response');
    }

    const rates: FXRate[] = [];
    for (const row of res.data.data) {
        const parsed =
            typeof row.currename === 'string'
                ? parseCurrency(row.currename)
                : undefined;
        const buy = Number(row.buyrate);
        const sell = Number(row.salrate);
        if (
            !parsed ||
            !Number.isFinite(buy) ||
            !Number.isFinite(sell) ||
            buy <= 0 ||
            sell <= 0 ||
            buy >= sell
        ) {
            continue;
        }

        rates.push({
            currency: {
                from: parsed.from,
                to: 'HKD' as currency.HKD,
            },
            rate: {
                buy: { remit: buy },
                sell: { remit: sell },
                middle: (buy + sell) / 2,
            },
            unit: parsed.unit,
            updated: parseDate(row.updateTime),
        });
    }

    if (rates.length === 0) {
        throw new Error('ICBC Asia returned no rates');
    }
    return rates.sort();
};

export default getICBCAFXRates;
