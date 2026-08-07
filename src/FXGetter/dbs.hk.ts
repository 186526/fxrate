import axios from 'axios';
import { FXRate } from 'src/types.d';
import { DBSRow, parseDBSHKUSDRow, parseDBSRow } from './dbs-shared';

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
        // HKD 计价：「1 外币 = X HKD」（hkdTTBuy/hkdTTSell 直接透传）
        const hkd = parseDBSRow(
            { ...r, ttBuy: r.hkdTTBuy, ttSell: r.hkdTTSell },
            'HKD',
            date,
        );
        if (hkd) rates.push(hkd);

        // USD 计价：usdTT 是「1 USD = X 外币」口径（USD 行恒为 1.0，实测 2026-08，
        // CNY/CNH 行同口径），与 HKD 计价方向相反，必须取倒数生成「1 外币 = X USD」。
        const usd = parseDBSHKUSDRow(r, date);
        if (usd) rates.push(usd);
    }
    return rates.sort();
};

export default getDBSHKFXRates;
