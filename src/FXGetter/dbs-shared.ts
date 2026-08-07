import { FXRate, currency } from 'src/types.d';

// 星展银行（DBS）三地汇率 API 共享解析（2026-08 实测，均无需认证直连）：
//   HK: https://www.dbs.com.hk/hk-rates-api/v1/api/hkrates/latestForexRates
//       字段：{ currency, hkdTTBuy, hkdTTSell, usdTTBuy, usdTTSell }（TT=电汇）
//   SG: https://www.dbs.com.sg/sg-rates-api/v1/api/sgrates/getCurrencyConversionRates?FETCH_LATEST=1
//       字段：{ currency, ttSell, ttBuy, quoteCurrency, ... }（quoteCurrency='SGD' 的对）
//   CN: https://www.dbs.com.cn/cn-rates-api/v1/api/cnrates/latestForexRates
//       字段：{ currency, ttSell, ttBuy, cashSell, cashBuy }（CNY 基准）
// Buy/Sell 是银行视角：rate.buy = 银行买外币价（客户卖外币得本币），
// rate.sell = 银行卖外币价（客户买外币付本币）——与前端契约一致（rate.buy < rate.sell）。

export type DBSRow = {
    currency: string;
    hkdTTBuy?: string;
    hkdTTSell?: string;
    usdTTBuy?: string;
    usdTTSell?: string;
    ttBuy?: string;
    ttSell?: string;
    cashBuy?: string;
    cashSell?: string;
    quoteCurrency?: string;
    /** SG 专用：基准货币报价单位（JPY 等为 '100'，其余 '1'）；HK/CN 无此字段（恒为 1 单位） */
    baseCurrencyUnit?: string;
};

export const parseDBSRow = (
    r: DBSRow,
    to: string,
    date: Date,
): FXRate | null => {
    // 过滤无效条目：货币代码必须为 3 字母；buy/sell 必须为正数（SG 返回的
    // KHR/MM1/RUB/TRY 等行 ttBuy/ttSell 为 0.000000 或空，实测为数据垃圾）。
    if (!/^[A-Z]{3}$/.test(r.currency)) return null;
    const buy = parseFloat(r.ttBuy ?? r.hkdTTBuy ?? '');
    const sell = parseFloat(r.ttSell ?? r.hkdTTSell ?? '');
    const cashBuy = parseFloat(r.cashBuy ?? '');
    const cashSell = parseFloat(r.cashSell ?? '');
    const middle =
        Number.isFinite(buy) && Number.isFinite(sell)
            ? (buy + sell) / 2
            : undefined;

    if (buy <= 0 || sell <= 0) return null;
    if (
        !Number.isFinite(buy) &&
        !Number.isFinite(sell) &&
        middle === undefined
    ) {
        return null;
    }
    // SG 的 JPY 等按 100 单位报价（baseCurrencyUnit='100'），必须透传，
    // 否则「100 JPY = X」被当作「1 JPY = X」差 100 倍（2026-08 实测）。
    const unit = parseFloat(r.baseCurrencyUnit ?? '') || 1;
    return {
        currency: {
            from: r.currency as unknown as currency.unknown,
            to: to as unknown as currency.unknown,
        },
        rate: {
            buy: {
                cash: Number.isFinite(cashBuy) ? cashBuy : buy,
                remit: buy,
            },
            sell: {
                cash: Number.isFinite(cashSell) ? cashSell : sell,
                remit: sell,
            },
            middle,
        },
        unit,
        updated: date,
    } as FXRate;
};

// DBS HK 专用：usdTT 是「1 USD = X 外币」口径（USD 行恒为 1.0），与 HKD 计价
// 「1 外币 = X HKD」方向相反，必须取倒数生成「1 外币 = X USD」：
//   rate.buy（银行买外币付 USD）= 1/银行卖 USD 收外币 = 1/usdTTBuy
//   rate.sell（银行卖外币收 USD）= 1/银行买 USD 付外币 = 1/usdTTSell
// 曾只对 CNY/CNH 取倒数、其他外币直接透传，导致 SGD 等行方向反了
// （「1 USD = 1.29 SGD」被当「1 SGD = 1.29 USD」），2026-08 修复为全外币统一倒数。
export const parseDBSHKUSDRow = (r: DBSRow, date: Date): FXRate | null => {
    const usdBuy = parseFloat(r.usdTTBuy ?? '');
    const usdSell = parseFloat(r.usdTTSell ?? '');
    if (
        !Number.isFinite(usdBuy) ||
        !Number.isFinite(usdSell) ||
        usdBuy <= 0 ||
        usdSell <= 0
    ) {
        return null;
    }
    return parseDBSRow(
        {
            ...r,
            ttBuy: String(1 / usdBuy),
            ttSell: String(1 / usdSell),
        },
        'USD',
        date,
    );
};
