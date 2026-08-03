import axios from 'axios';
import { FXRate, currency } from 'src/types.d';

type CQTGRow = {
    PUBLISH_TIME: string;
    CCY: string;
    CASH_SELL_RATE: string;
    CCY_BUY_RATE: string;
    MDL_RATE: string;
    EXCH_RATE_UNIT: string;
    CASH_BUY_RATE: string;
    CCY_NAME: string;
    CCY_SELL_RATE: string;
};

type CQTGResponse = {
    success: boolean;
    info?: CQTGRow[];
};

const currencyMap: Record<string, currency> = {
    '036': currency.AUD,
    '124': currency.CAD,
    '344': currency.HKD,
    '392': currency.JPY,
    '702': currency.SGD,
    '756': currency.CHF,
    '826': currency.GBP,
    '840': currency.USD,
    '978': currency.EUR,
};

const parseDate = (value: string): Date => {
    const date = new Date(`${value.replace(' ', 'T')}+08:00`);
    return Number.isFinite(date.getTime()) ? date : new Date();
};

const getCQTGFXRates = async (): Promise<FXRate[]> => {
    const res = await axios.get<CQTGResponse>(
        'https://www.ccqtgb.com/ajax/getPJ',
        {
            timeout: 10000,
            headers: {
                'User-Agent':
                    process.env['HEADER_USER_AGENT'] ??
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
            },
        },
    );

    if (!res.data.success || !Array.isArray(res.data.info)) {
        throw new Error('Chongqing Three Gorges Bank returned no rates');
    }

    const rates: FXRate[] = [];
    for (const row of res.data.info) {
        const from = currencyMap[row.CCY];
        const cashBuy = parseFloat(row.CASH_BUY_RATE);
        const remitBuy = parseFloat(row.CCY_BUY_RATE);
        const cashSell = parseFloat(row.CASH_SELL_RATE);
        const remitSell = parseFloat(row.CCY_SELL_RATE);
        const middle = parseFloat(row.MDL_RATE);
        const unit = parseFloat(row.EXCH_RATE_UNIT);

        if (
            !from ||
            ![cashBuy, remitBuy, cashSell, remitSell, middle, unit].every(
                (value) => Number.isFinite(value) && value > 0,
            ) ||
            cashBuy >= cashSell ||
            remitBuy >= remitSell
        ) {
            continue;
        }

        rates.push({
            currency: {
                from,
                to: currency.CNY,
            },
            rate: {
                buy: {
                    cash: cashBuy,
                    remit: remitBuy,
                },
                sell: {
                    cash: cashSell,
                    remit: remitSell,
                },
                middle,
            },
            unit,
            updated: parseDate(row.PUBLISH_TIME),
        });
    }

    return rates.sort();
};

export default getCQTGFXRates;
