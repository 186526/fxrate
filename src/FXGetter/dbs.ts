import axios from 'axios';
import { FXRate } from 'src/types.d';
import { DBSRow, parseDBSRow } from './dbs-shared';

// 星展银行有限公司（DBS Bank Ltd, 新加坡总部）汇率。
// API: https://www.dbs.com.sg/sg-rates-api/v1/api/sgrates/getCurrencyConversionRates?FETCH_LATEST=1
// 返回全组合（530 条，baseCurrency 与 quoteCurrency 双向），只取「1 外币 = X SGD」方向。
const getDBSFXRates = async (): Promise<FXRate[]> => {
    const res = await axios.get(
        'https://www.dbs.com.sg/sg-rates-api/v1/api/sgrates/getCurrencyConversionRates?FETCH_LATEST=1',
        {
            headers: {
                'User-Agent':
                    process.env['HEADER_USER_AGENT'] ?? 'fxrate axios/latest',
            },
            timeout: 10000,
        },
    );
    const rows = res.data.results.assets[0].recData as DBSRow[];
    const date = new Date();

    const rates: FXRate[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
        // 只取「1 外币 = X SGD」方向（quoteCurrency === 'SGD'），跳过其他组合与 SGD 自身。
        if (r.quoteCurrency !== 'SGD' || r.currency === 'SGD') continue;
        if (seen.has(r.currency)) continue;
        seen.add(r.currency);
        const fx = parseDBSRow(r, 'SGD', date);
        if (fx) rates.push(fx);
    }
    return rates.sort();
};

export default getDBSFXRates;
