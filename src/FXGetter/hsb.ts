import axios from 'axios';

import { currency, FXRate } from 'src/types.d';

const API_URL =
    'https://rbwm-api.hsbc.com.hk/pws-hk-hase-rates-papi-prod-proxy/v1/fxtt-exchange-rates?isIncludeCcyNameLang=N';

const currencies: Record<string, currency> = {
    USD: 'USD' as currency.USD,
    CNY: 'CNY' as currency.CNY,
    CNH: 'CNH' as currency.CNH,
    AUD: 'AUD' as currency.AUD,
    CAD: 'CAD' as currency.CAD,
    CHF: 'CHF' as currency.CHF,
    EUR: 'EUR' as currency.EUR,
    GBP: 'GBP' as currency.GBP,
    JPY: 'JPY' as currency.JPY,
    NZD: 'NZD' as currency.NZD,
    SGD: 'SGD' as currency.SGD,
    THB: 'THB' as currency.THB,
    ZAR: 'ZAR' as currency.ZAR,
};

interface HSBRateItem {
    ccyCode: string;
    ccyDisplayCode: string;
    ccyBaseRemark?: string;
    ttBuyRate: string;
    ttSellRate: string;
}

interface HSBResponse {
    lastUpdateTime: string;
    fxttExchangeRates: HSBRateItem[];
}

const parseUnit = (remark?: string): number => {
    const match = remark?.replace(/,/g, '').match(/per\s+(\d+)/i);
    if (!match) return 1;

    const unit = parseInt(match[1], 10);
    return Number.isFinite(unit) && unit > 0 ? unit : 1;
};

const getHSBFXRates = async (): Promise<FXRate[]> => {
    const response = await axios.get<HSBResponse>(API_URL, {
        timeout: 10000,
        headers: {
            'User-Agent':
                process.env['HEADER_USER_AGENT'] ??
                'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36',
            'X-HSBC-Locale': 'en_HK',
            'X-HSBC-Channel-Id': 'PWS',
            'X-HSBC-Chnl-CountryCode': 'HK',
        },
    });

    const parsedUpdated = new Date(response.data.lastUpdateTime);
    const updated = Number.isNaN(parsedUpdated.getTime())
        ? new Date()
        : parsedUpdated;

    return (response.data.fxttExchangeRates ?? [])
        .flatMap((item): FXRate[] => {
            const from = currencies[item.ccyDisplayCode?.trim().toUpperCase()];
            const buy = parseFloat(item.ttBuyRate);
            const sell = parseFloat(item.ttSellRate);
            if (
                !from ||
                !Number.isFinite(buy) ||
                !Number.isFinite(sell) ||
                buy <= 0 ||
                sell <= 0 ||
                buy >= sell
            ) {
                return [];
            }

            return [
                {
                    currency: {
                        from,
                        to: 'HKD' as currency.HKD,
                    },
                    rate: {
                        buy: { remit: buy },
                        sell: { remit: sell },
                    },
                    unit: parseUnit(item.ccyBaseRemark),
                    updated,
                },
            ];
        })
        .sort((a, b) =>
            String(a.currency.from).localeCompare(String(b.currency.from)),
        );
};

export default getHSBFXRates;
