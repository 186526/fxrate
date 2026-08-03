import axios from 'axios';
import { FXRate, currency } from 'src/types.d';

// 香港金融管理局（HKMA）官方汇率：每单位外币兑港元的每日数字。
// API: https://api.hkma.gov.hk/public/market-data-and-statistics/monthly-statistical-bulletin/er-ir/er-eeri-daily
// records[0] = { end_of_day: "2026-06-30", usd: 7.844, eur: 8.944, jpy: 0.0483, cny: 1.1549, ... }
// 语义：usd = 1 USD = X HKD（官方中间价，无买卖价）。数据按月发布（金管局惯例），滞后约 1-2 天。
const getHKMAFXRates = async (): Promise<FXRate[]> => {
    const res = await axios.get(
        'https://api.hkma.gov.hk/public/market-data-and-statistics/monthly-statistical-bulletin/er-ir/er-eeri-daily?offset=0',
        {
            headers: {
                'User-Agent':
                    process.env['HEADER_USER_AGENT'] ?? 'fxrate axios/latest',
            },
            timeout: 10000,
        },
    );

    const record = res.data.result.records[0] as Record<
        string,
        string | number | null
    >;
    const date = new Date(`${String(record.end_of_day)}T00:00:00+08:00`);

    // 已知的货币代码字段（HKMA 固定字段）；跳过港币自身与非货币字段。
    const CCY_FIELDS = [
        'usd',
        'gbp',
        'jpy',
        'cad',
        'aud',
        'sgd',
        'twd',
        'chf',
        'cny',
        'krw',
        'thb',
        'myr',
        'eur',
        'php',
        'inr',
        'idr',
        'zar',
    ];

    const rates: FXRate[] = [];
    for (const field of CCY_FIELDS) {
        const value = record[field];
        const middle =
            typeof value === 'number' ? value : parseFloat(String(value));
        if (!Number.isFinite(middle) || middle <= 0) continue;
        rates.push({
            currency: {
                from: field.toUpperCase() as unknown as currency.unknown,
                to: 'HKD' as currency.HKD,
            },
            rate: {
                middle,
            },
            unit: 1,
            updated: date,
        } as FXRate);
    }
    return rates.sort();
};

export default getHKMAFXRates;
