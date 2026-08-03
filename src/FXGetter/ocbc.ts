import axios from 'axios';

import { FXRate, currency } from 'src/types.d';

const API_URL = 'https://www.ocbc.com/fxrates/bootstrap.json';
const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36';

interface OCBCTieredRate {
    tierLevel?: number;
    bankBuyRate?: number | string;
    bankSellRate?: number | string;
}

interface OCBCRateItem {
    baseCurrencyCode?: string;
    exchangeCurrencyCode?: string;
    middleExchangeRate?: number | string;
    tieredExchangeRates?: OCBCTieredRate[];
    unitForSGDExchange?: number | string;
}

interface OCBCResponse {
    fxRatesSgd?: OCBCRateItem[];
    lastUpdated?: string;
}

const parseUpdated = (value?: string): Date => {
    if (!value) return new Date();
    const normalized = /(?:Z|[+-]\d{2}:\d{2})$/.test(value)
        ? value
        : `${value}+08:00`;
    const updated = new Date(normalized);
    return Number.isFinite(updated.getTime()) ? updated : new Date();
};

const getOCBCFXRates = async (): Promise<FXRate[]> => {
    const res = await axios.get<OCBCResponse>(API_URL, {
        timeout: 10000,
        headers: {
            'User-Agent': process.env['HEADER_USER_AGENT'] ?? USER_AGENT,
        },
    });

    if (!Array.isArray(res.data.fxRatesSgd)) {
        throw new Error('OCBC Singapore returned an invalid response');
    }

    const updated = parseUpdated(res.data.lastUpdated);
    const rates: FXRate[] = [];
    for (const row of res.data.fxRatesSgd) {
        const from = row.baseCurrencyCode?.trim().toUpperCase();
        const tier = row.tieredExchangeRates?.find(
            (item) => item.tierLevel === 1,
        );
        const buy = Number(tier?.bankBuyRate);
        const sell = Number(tier?.bankSellRate);
        const middle = Number(row.middleExchangeRate);
        const unit = Number(row.unitForSGDExchange);
        if (
            !from ||
            !/^[A-Z]{3}$/.test(from) ||
            row.exchangeCurrencyCode !== 'SGD' ||
            from === 'SGD' ||
            !Number.isFinite(buy) ||
            !Number.isFinite(sell) ||
            !Number.isFinite(middle) ||
            !Number.isFinite(unit) ||
            buy <= 0 ||
            sell <= 0 ||
            middle <= 0 ||
            unit <= 0 ||
            buy >= sell
        ) {
            continue;
        }

        rates.push({
            currency: {
                from: from as unknown as currency.unknown,
                to: 'SGD' as currency.SGD,
            },
            rate: {
                buy: { remit: buy },
                sell: { remit: sell },
                middle,
            },
            unit,
            updated,
        });
    }

    if (rates.length === 0) {
        throw new Error('OCBC Singapore returned no valid rates');
    }
    return rates.sort();
};

export default getOCBCFXRates;
