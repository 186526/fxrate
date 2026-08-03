import axios from 'axios';
import { FXRate, currency } from 'src/types.d';

interface BOSCRateItem {
    currency1: string;
    currency2: string;
    unit: string;
    midPrice: string;
    buyPrice: string;
    sellPrice: string;
    cashBuyPrice: string;
    createTime: string;
}

interface BOSCResponse {
    code: number;
    success: boolean;
    data: BOSCRateItem[];
}

const getBOSCFXRates = async (): Promise<FXRate[]> => {
    const res = await axios.get<BOSCResponse>(
        'https://www.bosc.cn/apiQry/apiQry/qryMcForexch',
        {
            timeout: 10000,
            headers: {
                'User-Agent':
                    process.env['HEADER_USER_AGENT'] ?? 'fxrate axios/latest',
            },
        },
    );

    if (!res.data.success || !Array.isArray(res.data.data)) {
        throw new Error(
            `BOSC response format changed: code=${res.data.code} success=${res.data.success}`,
        );
    }

    return res.data.data
        .map((row): FXRate | null => {
            if (!row.currency1 || !row.currency2) return null;

            const unit = parseInt(row.unit, 10);
            const middle = parseFloat(row.midPrice);
            const remitBuy = parseFloat(row.buyPrice);
            const cashBuy = parseFloat(row.cashBuyPrice);
            const sell = parseFloat(row.sellPrice);
            const values = [unit, middle, remitBuy, cashBuy, sell];
            if (!values.every(Number.isFinite) || unit <= 0) return null;

            const parsedUpdated = new Date(`${row.createTime}+08:00`);

            return {
                currency: {
                    from: row.currency1 as currency,
                    to: row.currency2 as currency,
                },
                rate: {
                    buy: {
                        remit: remitBuy,
                        cash: cashBuy,
                    },
                    sell: {
                        remit: sell,
                        cash: sell,
                    },
                    middle,
                },
                unit,
                updated: Number.isNaN(parsedUpdated.getTime())
                    ? new Date()
                    : parsedUpdated,
            };
        })
        .filter((rate): rate is FXRate => rate !== null);
};

export default getBOSCFXRates;
