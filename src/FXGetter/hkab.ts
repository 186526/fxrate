import axios from 'axios';
import { FXRate, currency } from 'src/types.d';

// 香港银行公会（HKAB）每日电汇汇率（T/T rates）：
//   https://www.hkab.org.hk/sc/rates/exchange-rates（Nuxt SSR 页，数据内嵌 __NUXT_DATA__）
// 数据：每日发布（RateDate 当天，2026-08 实测），HKD 基准，字段 {CCY}Selling（银行卖出）、
// {CCY}BuyingTT（电汇买入）、{CCY}BuyingOD（现钞买入）。
// 单位（2026-08 用 USD 交叉验证）：GBP 为 1 单位（10.66 = 1 GBP），其余全部 100 单位
// （USD 787.25 = 100 USD，JPY 5.0715 = 100 JPY，WON 0.5705 = 100 WON）。
// Selling=银行卖出价（客户买外币付 HKD，高）→ rate.sell；
// BuyingTT=银行电汇买入价（客户卖外币得 HKD，低）→ rate.buy.remit；
// BuyingOD=银行现钞买入价（更低）→ rate.buy.cash。

const PAGE_URL = 'https://www.hkab.org.hk/sc/rates/exchange-rates';

// 与 currency 枚举对应的货币（HKAB 字段名 = 3 字母 ISO 码，GBP/JPY 等可直接映射）
const CURRENCY_MAP: Record<string, currency> = {
    AUD: 'AUD' as currency.AUD,
    BND: 'BND' as currency.BND,
    CAD: 'CAD' as currency.CAD,
    CHF: 'CHF' as currency.CHF,
    CNH: 'CNH' as currency.CNH,
    CNY: 'CNY' as currency.CNY,
    DKK: 'DKK' as currency.DKK,
    EUR: 'EUR' as currency.EUR,
    GBP: 'GBP' as currency.GBP,
    INR: 'INR' as currency.INR,
    JPY: 'JPY' as currency.JPY,
    MYR: 'MYR' as currency.MYR,
    NOK: 'NOK' as currency.NOK,
    NTD: 'TWD' as currency.TWD,
    NZD: 'NZD' as currency.NZD,
    PHP: 'PHP' as currency.PHP,
    PKR: 'PKR' as currency.PKR,
    SEK: 'SEK' as currency.SEK,
    SGD: 'SGD' as currency.SGD,
    THB: 'THB' as currency.THB,
    USD: 'USD' as currency.USD,
    WON: 'KRW' as currency.KRW,
    ZAR: 'ZAR' as currency.ZAR,
};

// 1 单位的货币（其余 100 单位；GBP 是唯一例外，2026-08 交叉验证）
const UNIT_ONE: Record<string, number> = {
    GBP: 1,
};

// Nuxt SSR payload 是扁平数组：字段值是数组索引，13 表示 null（该货币当日无报价）。
// 递归解引用索引得到真实值（汇率以字符串存储，如 "787.25"）。
const extractRates = (
    payload: unknown[],
): Record<string, { sell: number; buyTT: number; buyOD: number }> => {
    const deref = (v: unknown): unknown => {
        if (typeof v === 'number' && v !== 13 && v >= 0 && v < payload.length) {
            return deref(payload[v]);
        }
        return v;
    };

    // 找汇率对象（含 USDSelling 字段的 dict）
    const rateObj = payload.find(
        (item): item is Record<string, unknown> =>
            typeof item === 'object' && item !== null && 'USDSelling' in item,
    );
    if (!rateObj) throw new Error('HKAB: rate object not found in payload');

    const toNum = (v: unknown): number | undefined => {
        const n = typeof v === 'number' ? v : parseFloat(String(v));
        return Number.isFinite(n) && n > 0 ? n : undefined;
    };

    const out: Record<string, { sell: number; buyTT: number; buyOD: number }> =
        {};
    for (const ccy of Object.keys(CURRENCY_MAP)) {
        const sell = toNum(deref(rateObj[`${ccy}Selling`]));
        const buyTT = toNum(deref(rateObj[`${ccy}BuyingTT`]));
        const buyOD = toNum(deref(rateObj[`${ccy}BuyingOD`]));
        if (sell === undefined || buyTT === undefined || buyOD === undefined) {
            continue;
        }
        out[ccy] = { sell, buyTT, buyOD };
    }
    return out;
};

const parseRateDate = (payload: unknown[]): Date => {
    const deref = (v: unknown): unknown => {
        if (typeof v === 'number' && v !== 13 && v >= 0 && v < payload.length) {
            return deref(payload[v]);
        }
        return v;
    };
    const rateObj = payload.find(
        (item): item is Record<string, unknown> =>
            typeof item === 'object' && item !== null && 'USDSelling' in item,
    );
    const raw = rateObj ? deref(rateObj['RateDate']) : undefined;
    const date =
        typeof raw === 'string'
            ? new Date(`${raw}T00:00:00+08:00`)
            : new Date();
    return Number.isNaN(date.getTime()) ? new Date() : date;
};

const getHKABFXRates = async (): Promise<FXRate[]> => {
    const res = await axios.get<string>(PAGE_URL, {
        timeout: 15000,
        headers: {
            'User-Agent':
                process.env['HEADER_USER_AGENT'] ??
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
        },
    });

    const match = res.data.match(
        /<script[^>]*id="__NUXT_DATA__"[^>]*>(.*?)<\/script>/s,
    );
    if (!match) throw new Error('HKAB: __NUXT_DATA__ payload not found');
    const payload = JSON.parse(match[1]) as unknown[];

    const rates = extractRates(payload);
    const updated = parseRateDate(payload);

    return Object.entries(rates)
        .map(([ccy, r]): FXRate | null => {
            const from = CURRENCY_MAP[ccy];
            if (!from) return null;
            // 方向契约：银行买价（客户卖外币，低）< 银行卖价（客户买外币，高）
            if (r.buyTT >= r.sell || r.buyOD >= r.sell) return null;
            return {
                currency: {
                    from,
                    to: 'HKD' as currency.HKD,
                },
                rate: {
                    buy: {
                        remit: r.buyTT,
                        cash: r.buyOD,
                    },
                    sell: {
                        remit: r.sell,
                        cash: r.sell,
                    },
                },
                unit: UNIT_ONE[ccy] ?? 100,
                updated,
            } as FXRate;
        })
        .filter((fx): fx is FXRate => fx !== null)
        .sort();
};

export default getHKABFXRates;
