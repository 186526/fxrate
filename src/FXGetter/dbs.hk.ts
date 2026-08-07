import axios from 'axios';
import { FXRate } from 'src/types.d';
import { DBSRow, parseDBSRow } from './dbs-shared';

// 星展银行（香港）有限公司汇率。
// API: https://www.dbs.com.hk/hk-rates-api/v1/api/hkrates/latestForexRates
// 字段：{ currency, hkdTTBuy, hkdTTSell, usdTTBuy, usdTTSell }。
// DBS HK 的 source 语义是 HKD 基准：只发布「外币 → HKD」边。
// API 中的 usdTT* 是参考字段，不代表该 source 提供「外币 → USD」牌价，必须忽略。
export const parseDBSHKRows = (rows: DBSRow[], date: Date): FXRate[] => {
    const rates: FXRate[] = [];
    for (const r of rows) {
        if (r.currency === 'HKD' || r.currency === 'USD') continue;
        // HKD 计价：「1 外币 = X HKD」（hkdTTBuy/hkdTTSell 直接透传）
        const hkd = parseDBSRow(
            { ...r, ttBuy: r.hkdTTBuy, ttSell: r.hkdTTSell },
            'HKD',
            date,
        );
        if (hkd) rates.push(hkd);
    }
    return rates.sort();
};

const getDBSHKFXRates = async (): Promise<FXRate[]> => {
    const res = await axios.get(
        'https://www.dbs.com.hk/hk-rates-api/v1/api/hkrates/latestForexRates',
        {
            headers: {
                'User-Agent':
                    process.env['HEADER_USER_AGENT'] ?? 'fxrate axios/latest',
            },
            timeout: 10000,
        },
    );
    const rows = res.data.results.assets[0].recData as DBSRow[];
    return parseDBSHKRows(rows, new Date());
};

export default getDBSHKFXRates;
