import axios from 'axios';
import { FXRate } from 'src/types.d';
import { DBSRow, parseDBSRow } from './dbs-shared';

// 星展银行（中国）有限公司汇率。
// API: https://www.dbs.com.cn/cn-rates-api/v1/api/cnrates/latestForexRates
// 字段：{ currency, ttSell, ttBuy, cashSell, cashBuy }（CNY 基准，10 种货币）。
const getDBSCNFXRates = async (): Promise<FXRate[]> => {
    const res = await axios.get(
        'https://www.dbs.com.cn/cn-rates-api/v1/api/cnrates/latestForexRates',
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
    for (const r of rows) {
        if (r.currency === 'CNY') continue;
        const fx = parseDBSRow(r, 'CNY', date);
        if (fx) rates.push(fx);
    }
    return rates.sort();
};

export default getDBSCNFXRates;
