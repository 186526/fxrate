import axios from 'axios';
import { FXRate, currency } from 'src/types.d';

type GHBankRow = {
    crcycd: string;
    csbypr: string;
    csslpr: string;
    efTime: string;
    efctdt: string;
    exbypr: string;
    exslpr: string;
    middpr: string;
};

type GHBankResponse = {
    success: string;
    list?: GHBankRow[];
};

const currencyMap: Record<string, currency> = {
    AUD: currency.AUD,
    CHF: currency.CHF,
    HKD: currency.HKD,
    SGD: currency.SGD,
    JPY: currency.JPY,
    EUR: currency.EUR,
    GBP: currency.GBP,
    CAD: currency.CAD,
    USD: currency.USD,
    RUB: currency.RUB,
};

const parseDate = (dateValue: string, timeValue: string): Date => {
    if (!/^\d{8}$/.test(dateValue)) return new Date();
    const iso =
        `${dateValue.slice(0, 4)}-${dateValue.slice(4, 6)}-${dateValue.slice(6, 8)}` +
        `T${timeValue}+08:00`;
    const date = new Date(iso);
    return Number.isFinite(date.getTime()) ? date : new Date();
};

const getGHBFXRates = async (): Promise<FXRate[]> => {
    const res = await axios.get<GHBankResponse>(
        'https://www.ghbank.com.cn/product/findForeignExchangeList',
        {
            timeout: 10000,
            headers: {
                'User-Agent':
                    process.env['HEADER_USER_AGENT'] ??
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
                systemID: 'NMB',
                srcSystemID: 'NMB',
            },
        },
    );

    if (res.data.success !== 'true' || !Array.isArray(res.data.list)) {
        throw new Error('Guangdong Huaxing Bank returned no rates');
    }

    const rates: FXRate[] = [];
    for (const row of res.data.list) {
        const from = currencyMap[row.crcycd];
        const cashBuy = parseFloat(row.csbypr);
        const cashSell = parseFloat(row.csslpr);
        const remitBuy = parseFloat(row.exbypr);
        const remitSell = parseFloat(row.exslpr);
        const middle = parseFloat(row.middpr);

        if (
            !from ||
            ![cashBuy, cashSell, remitBuy, remitSell, middle].every(
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
            unit: 1,
            updated: parseDate(row.efctdt, row.efTime),
        });
    }

    return rates.sort();
};

export default getGHBFXRates;
