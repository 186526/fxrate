import axios from 'axios';
import crypto from 'crypto';
import https from 'https';
import { FXRate, currency } from 'src/types.d';

interface BOBRateItem {
    engCode: string;
    quotationUnit: number;
    rateBuying: number;
    rateCashBuying: number;
    rateSelling: number;
    rateMiddle: number;
    currentDate: string;
}

interface BOBResponse {
    code: number;
    message: string;
    data: BOBRateItem[];
}

const httpsAgent = new https.Agent({
    secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
});

const parseCurrentDate = (value: string): Date => {
    const match = value.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (!match) return new Date();

    return new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00+08:00`);
};

const getBOBFXRates = async (): Promise<FXRate[]> => {
    const res = await axios.post<BOBResponse>(
        'https://www.bankofbeijing.com.cn/api/foreignRate/queryList',
        {},
        {
            httpsAgent,
            timeout: 10000,
            headers: {
                'Content-Type': 'application/json',
                'User-Agent':
                    process.env['HEADER_USER_AGENT'] ?? 'fxrate axios/latest',
            },
        },
    );

    if (res.data.code !== 0 || !Array.isArray(res.data.data)) {
        throw new Error(
            `BOB response format changed: code=${res.data.code} message=${res.data.message}`,
        );
    }

    return res.data.data
        .map((row): FXRate | null => {
            const [from, to] = row.engCode.split('/');
            if (!from || !to) return null;

            const values = [
                row.rateBuying,
                row.rateCashBuying,
                row.rateSelling,
                row.rateMiddle,
                row.quotationUnit,
            ];
            if (!values.every(Number.isFinite) || row.quotationUnit <= 0) {
                return null;
            }

            return {
                currency: {
                    from: from as currency,
                    to: to as currency,
                },
                rate: {
                    buy: {
                        remit: row.rateBuying,
                        cash: row.rateCashBuying,
                    },
                    sell: {
                        remit: row.rateSelling,
                        cash: row.rateSelling,
                    },
                    middle: row.rateMiddle,
                },
                unit: row.quotationUnit,
                updated: parseCurrentDate(row.currentDate),
            };
        })
        .filter((rate): rate is FXRate => rate !== null);
};

export default getBOBFXRates;
