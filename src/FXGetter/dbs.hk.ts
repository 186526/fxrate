import axios from 'axios';
import { FXRate } from 'src/types.d';
import { DBSRow, parseDBSRow } from './dbs-shared';

// 星展银行（香港）有限公司汇率。
// API: https://www.dbs.com.hk/hk-rates-api/v1/api/hkrates/latestForexRates
// 字段：{ currency, hkdTTBuy, hkdTTSell, usdTTBuy, usdTTSell }（每货币同时提供 HKD 与 USD 计价）。
// 保留全部外币（含 CNY/CNH，生成 CNY→HKD、CNY→USD 等方向），仅跳过基准货币 HKD/USD 自身。
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
    const date = new Date();

    const rates: FXRate[] = [];
    for (const r of rows) {
        if (r.currency === 'HKD' || r.currency === 'USD') continue;
        const hkd = parseDBSRow(
            { ...r, ttBuy: r.hkdTTBuy, ttSell: r.hkdTTSell },
            'HKD',
            date,
        );
        if (hkd) rates.push(hkd);

        // CNY/CNH 行的 usdTT 是「1 USD = X CNY」方向（与 USD 行同口径，实测 2026-08），
        // 而 HKD 计价是「1 CNY = X HKD」——两个计价方向相反。
        // 因此 USD 计价取倒数生成「1 CNY = X USD」：
        //   rate.buy（客户买 CNY 付 USD）= 1/银行买 USD 付 CNY = 1/usdTTBuy
        //   rate.sell（客户卖 CNY 得 USD）= 1/银行卖 USD 收 CNY = 1/usdTTSell
        if (r.currency === 'CNY' || r.currency === 'CNH') {
            const usdBuy = parseFloat(r.usdTTBuy ?? '');
            const usdSell = parseFloat(r.usdTTSell ?? '');
            if (usdBuy > 0 && usdSell > 0) {
                const cn = parseDBSRow(
                    {
                        ...r,
                        ttBuy: String(1 / usdBuy),
                        ttSell: String(1 / usdSell),
                    },
                    'USD',
                    date,
                );
                if (cn) rates.push(cn);
            }
            continue;
        }
        const usd = parseDBSRow(
            { ...r, ttBuy: r.usdTTBuy, ttSell: r.usdTTSell },
            'USD',
            date,
        );
        if (usd) rates.push(usd);
    }
    return rates.sort();
};

export default getDBSHKFXRates;
