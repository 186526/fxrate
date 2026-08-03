import fxManager, { FXRateType } from '../fxm/fxManager';
import { fraction, divide } from 'mathjs';

import { LRUCache } from 'lru-cache';
import { currency } from 'src/types.d';

const cache = new LRUCache<string, string>({
    max: 500,
    ttl: 1000 * 60 * 30,
    ttlAutopurge: true,
});

// 常见浏览器 UA 池：Akamai 对 undici 默认 UA 返回 403，需伪装浏览器。
// 进程启动时随机固定一个（不逐请求更换，避免 UA 漂移被反爬识别）。
const BROWSER_UA_POOL = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
];
const BROWSER_UA =
    BROWSER_UA_POOL[Math.floor(Math.random() * BROWSER_UA_POOL.length)];

const currenciesList: string[] = [
    'AFN',
    'ALL',
    'DZD',
    'AOA',
    'ARS',
    'AMD',
    'AWG',
    'AUD',
    'AZN',
    'BSD',
    'BHD',
    'BDT',
    'BBD',
    'BYN',
    'BZD',
    'BMD',
    'BTN',
    'BOB',
    'BAM',
    'BWP',
    'BRL',
    'BND',
    'BGN',
    'BIF',
    'KHR',
    'CAD',
    'CVE',
    'KYD',
    'XOF',
    'XAF',
    'XPF',
    'CLP',
    'CNY',
    'CNH',
    'COP',
    'KMF',
    'CDF',
    'CRC',
    'CUP',
    'CZK',
    'DKK',
    'DJF',
    'DOP',
    'XCD',
    'EGP',
    'SVC',
    'ETB',
    'EUR',
    'FKP',
    'FJD',
    'GMD',
    'GEL',
    'GHS',
    'GIP',
    'GBP',
    'GTQ',
    'GNF',
    'GYD',
    'HTG',
    'HNL',
    'HKD',
    'HUF',
    'ISK',
    'INR',
    'IDR',
    'IQD',
    'ILS',
    'JMD',
    'JPY',
    'JOD',
    'KZT',
    'KES',
    'KWD',
    'KGS',
    'LAK',
    'LBP',
    'LSL',
    'LRD',
    'LYD',
    'MOP',
    'MKD',
    'MGA',
    'MWK',
    'MYR',
    'MVR',
    'MRU',
    'MUR',
    'MXN',
    'MDL',
    'MNT',
    'MAD',
    'MZN',
    'MMK',
    'NAD',
    'NPR',
    'ANG',
    'NZD',
    'NIO',
    'NGN',
    'NOK',
    'OMR',
    'PKR',
    'PAB',
    'PGK',
    'PYG',
    'PEN',
    'PHP',
    'PLN',
    'QAR',
    'RON',
    'RUB',
    'RWF',
    'SHP',
    'WST',
    'STN',
    'SAR',
    'RSD',
    'SCR',
    'SLE',
    'SGD',
    'SBD',
    'SOS',
    'ZAR',
    'KRW',
    'SSP',
    'LKR',
    'SDG',
    'SRD',
    'SZL',
    'SEK',
    'CHF',
    'TWD',
    'TJS',
    'TZS',
    'THB',
    'TOP',
    'TTD',
    'TND',
    'TRY',
    'TMT',
    'UGX',
    'UAH',
    'AED',
    'USD',
    'UYU',
    'UZS',
    'VUV',
    'VES',
    'VND',
    'YER',
    'ZMW',
    'ZWL',
];

export default class mastercardFXM extends fxManager {
    ableToGetAllFXRate: boolean = false;

    // 懒构建的汇率矩阵：currenciesList 是固定的，只需构建一次。
    // Proxy 只作为 cache 的同步读取器，网络请求统一走 async getfxRateList。
    private _lazyMatrix: {
        [from: string]: { [to: string]: FXRateType };
    } | null = null;

    public get fxRateList() {
        if (this._lazyMatrix) return this._lazyMatrix;

        const fxRateList: fxManager['_fxRateList'] = {};

        currenciesList.forEach((from) => {
            const _from = from == 'CNH' ? 'CNY' : from;

            fxRateList[from] = {};
            currenciesList.forEach((to) => {
                const _to = to == 'CNH' ? 'CNY' : to;

                const currency = new Proxy({} as FXRateType, {
                    get: (_obj, prop) => {
                        if (
                            !['cash', 'remit', 'middle', 'updated'].includes(
                                prop.toString(),
                            )
                        ) {
                            return undefined;
                        }

                        const cached = cache.get(`${_from}${_to}`);
                        // 未缓存时返回 undefined，由 getfxRateList 异步拉取并预热缓存。
                        if (!cached) return undefined;

                        if (
                            ['cash', 'remit', 'middle'].includes(
                                prop.toString(),
                            )
                        ) {
                            const data = JSON.parse(cached);
                            return divide(
                                fraction(data.data.transAmt),
                                fraction(data.data.conversionRate),
                            );
                        } else {
                            const data = JSON.parse(cached);
                            return new Date(data.data.fxDate);
                        }
                    },
                });
                fxRateList[from][to] = currency;
            });
        });

        this._lazyMatrix = fxRateList;
        return fxRateList;
    }

    public async getfxRateList(from: currency, to: currency) {
        const _from = from == 'CNH' ? 'CNY' : from;
        const _to = to == 'CNH' ? 'CNY' : to;

        if (
            !(
                currenciesList.includes(from as string) &&
                currenciesList.includes(to as string)
            )
        ) {
            throw new Error('Currency not supported');
        }

        if (cache.has(`${_from}${_to}`)) {
            return this.fxRateList[from][to];
        }

        // MasterCard 每日（美东时间）发布一次当日结算汇率。
        // 当天汇率尚未发布时接口返回 401（{ data: { errorCode, errorMessage } }），
        // 从 UTC 今天向前最多回退 7 天取最近一个已发布日期。
        // 注意：必须用 Node 原生 fetch（undici TLS/HTTP2 指纹），
        // axios/curl 的指纹会被 Akamai 403 拒绝。
        let data: { data: Record<string, string> } | null = null;
        for (let offset = 0; offset < 7; offset++) {
            const date = new Date();
            date.setUTCDate(date.getUTCDate() - offset);
            const exchangeDate = date.toISOString().slice(0, 10);

            // 请求方向沿用旧 API 语义：transCurr=to、crdhldBillCurr=from，
            // 返回的 conversionRate 是「1 to = X from」，Proxy 取倒数得到「1 from = X to」。
            const url =
                `https://www.mastercard.com/marketingservices/public/mccom-services/currency-conversions/conversion-rates` +
                `?exchange_date=${exchangeDate}` +
                `&transaction_currency=${_to}` +
                `&cardholder_billing_currency=${_from}` +
                `&bank_fee=0&transaction_amount=1`;

            let res: Response;
            try {
                res = await fetch(url, {
                    signal: AbortSignal.timeout(10000),
                    headers: {
                        accept: 'application/json, text/plain, */*',
                        // 必须带浏览器 UA：Node 26（Docker node:alpine 镜像）的 undici
                        // 默认 UA 会被 Akamai 识别为机器人返回 403；带浏览器 UA 后 200
                        // （2026-08 生产实测，本地 Node 24 不带 UA 也能过，统一带上更稳）。
                        // 进程启动时从常见浏览器 UA 池随机固定一个（不逐请求换，避免
                        // Akamai 的 UA 漂移检测），与真实用户指纹一致。
                        'user-agent': BROWSER_UA,
                    },
                });
            } catch (_e) {
                // 网络错误直接放弃回退（与日期无关，重试没有意义）。
                throw new Error(
                    `MasterCard network error for ${_from}/${_to}: ${(_e as Error).message}`,
                );
            }

            if (res.status === 200) {
                data = (await res.json()) as { data: Record<string, string> };
                if (!data.data?.conversionRate) {
                    throw new Error(
                        `MasterCard response missing conversionRate for ${_from}/${_to}`,
                    );
                }
                cache.set(`${_from}${_to}`, JSON.stringify(data));
                return this.fxRateList[from][to];
            }

            // 401/404 = 该日期尚未发布或超出范围，继续向前回退；
            // 其他状态码（403/5xx）视为真实失败，立即报错避免静默重试。
            if (res.status !== 401 && res.status !== 404) {
                throw new Error(
                    `MasterCard API ${res.status} for ${_from}/${_to} (${exchangeDate})`,
                );
            }
        }

        throw new Error(
            `MasterCard no published rate in last 7 days for ${_from}/${_to}`,
        );
    }

    public async getUpdatedDate(from: currency, to: currency): Promise<Date> {
        const rate = await this.getfxRateList(from, to);
        const updated = rate?.updated;
        if (!(updated instanceof Date)) {
            throw new Error(`FX Path from ${from} to ${to} not found`);
        }
        return updated;
    }

    constructor() {
        super([]);
    }

    public update(): void {
        throw new Error('Method is deprecated');
    }
}
