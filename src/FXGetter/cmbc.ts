import axios from 'axios';
import { FXRate, currency } from 'src/types.d';

interface CMBCResponse {
    result?: {
        buyPrice: number | string;
        domesticCurrency: string;
        foreignCurrency: string;
        sellPrice: number | string;
        updateTime: string;
    }[];
}

const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36';

const parseChinaDate = (value: string): Date => {
    const parsed = new Date(`${value.replace(' ', 'T')}+08:00`);
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
};

const getCMBCFXRates = async (): Promise<FXRate[]> => {
    const res = await axios.post<CMBCResponse>(
        'http://www.cmbc.com.cn/gw/po_web/queryExRateByForex.do',
        'cxfg=1&domesticCurrency=RMB',
        {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': process.env['HEADER_USER_AGENT'] ?? USER_AGENT,
            },
            timeout: 10000,
        },
    );

    if (!Array.isArray(res.data?.result)) {
        throw new Error('CMBC response format changed: result is not an array');
    }

    return res.data.result
        .map((row): FXRate | null => {
            const from = row.foreignCurrency.trim().toUpperCase();
            const buy = Number(row.buyPrice);
            const sell = Number(row.sellPrice);

            if (
                !/^[A-Z]{3}$/.test(from) ||
                !['RMB', 'CNY'].includes(row.domesticCurrency.trim()) ||
                !Number.isFinite(buy) ||
                !Number.isFinite(sell) ||
                buy <= 0 ||
                sell <= buy
            ) {
                return null;
            }

            return {
                currency: {
                    from: from as currency,
                    to: 'CNY' as currency.CNY,
                },
                rate: {
                    buy: {
                        remit: buy,
                        cash: buy,
                    },
                    sell: {
                        remit: sell,
                        cash: sell,
                    },
                },
                unit: from === 'JPY' ? 100 : 1,
                updated: parseChinaDate(row.updateTime),
            };
        })
        .filter((rate): rate is FXRate => rate !== null)
        .sort();
};

export default getCMBCFXRates;
