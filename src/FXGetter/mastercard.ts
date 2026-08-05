import fxManager, { FXRateType } from '../fxm/fxManager';
import { fraction, divide, type Fraction } from 'mathjs';

import { LRUCache } from 'lru-cache';
import { currency } from 'src/types.d';

import {
    CardCoordinator,
    createCardMatrix,
    createCardNegativeCache,
    validateCardRate,
    type CardRate,
    type CardSparseStats,
} from './cardCapacity';

const cache = new LRUCache<string, CardRate>({
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

type MastercardPayload = { data: Record<string, string> };

const normalizeCode = (code: string): string => (code === 'CNH' ? 'CNY' : code);

// 完整 7 日回退工作流（native fetch 路径）：从 UTC 今天向前最多 7 天，第一个 200 即返回；
// 401/404 视为「当日尚未发布」继续回退；其他状态码（403/5xx）视为真实失败立即抛错。
async function fetchMastercardRate(
    from: string,
    to: string,
): Promise<MastercardPayload> {
    for (let offset = 0; offset < 7; offset++) {
        const date = new Date();
        date.setUTCDate(date.getUTCDate() - offset);
        const exchangeDate = date.toISOString().slice(0, 10);

        // 请求方向沿用旧 API 语义：transCurr=to、crdhldBillCurr=from，
        // 返回的 conversionRate 是「1 to = X from」，Proxy 取倒数得到「1 from = X to」。
        const url =
            `https://www.mastercard.com/marketingservices/public/mccom-services/currency-conversions/conversion-rates` +
            `?exchange_date=${exchangeDate}` +
            `&transaction_currency=${to}` +
            `&cardholder_billing_currency=${from}` +
            `&bank_fee=0&transaction_amount=1`;

        let res: Response;
        try {
            res = await fetch(url, {
                signal: AbortSignal.timeout(10000),
                headers: {
                    accept: 'application/json, text/plain, */*',
                    // 必须带浏览器 UA（见 BROWSER_UA_POOL 注释）：Node 的 undici 默认 UA
                    // 会被 Akamai 识别为机器人返回 403，带浏览器 UA 后 200。
                    'user-agent': BROWSER_UA,
                },
            });
        } catch (_e) {
            // 网络错误直接放弃回退（与日期无关，重试没有意义）。
            throw new Error(
                `MasterCard network error for ${from}/${to}: ${(_e as Error).message}`,
            );
        }

        if (res.status === 200) {
            const data = (await res.json()) as MastercardPayload;
            if (!data.data?.conversionRate) {
                throw new Error(
                    `MasterCard response missing conversionRate for ${from}/${to}`,
                );
            }
            return data;
        }

        // 401/404 = 该日期尚未发布或超出范围，继续向前回退；
        // 其他状态码（403/5xx）视为真实失败，立即报错避免静默重试。
        if (res.status !== 401 && res.status !== 404) {
            throw new Error(
                `MasterCard API ${res.status} for ${from}/${to} (${exchangeDate})`,
            );
        }
    }

    throw new Error(
        `MasterCard no published rate in last 7 days for ${from}/${to}`,
    );
}

export const mastercardCoordinator = new CardCoordinator<
    MastercardPayload,
    CardRate
>({
    source: 'mastercard',
    positive: cache,
    negative: createCardNegativeCache(),
    normalize: normalizeCode,
    nativeWorkflow: fetchMastercardRate,
    validate: (data) => {
        if (!data.data?.conversionRate) {
            throw new Error('MasterCard response missing conversionRate');
        }
    },
    // 上游响应写缓存时一次性解析为类型化 CardRate（Proxy 读取零 JSON.parse）：
    // conversionRate 7.5 表示「1 CNY = 7.5 USD」，取倒数 → 1 USD = 1/7.5 CNY。
    serialize: (data) => {
        const rate = divide(
            fraction(data.data.transAmt),
            fraction(data.data.conversionRate),
        ) as Fraction;
        // fxDate 缺失/空/非字符串 → Invalid Date（new Date(null) 会变 epoch，必须显式拒），
        // 由 validateStored 拒进正缓存。
        const fxDate = data.data?.fxDate;
        const updated =
            typeof fxDate === 'string' && fxDate.length > 0
                ? new Date(fxDate)
                : new Date(Number.NaN);
        return {
            middle: rate,
            cash: rate,
            remit: rate,
            updated,
        };
    },
    // 最终校验门：写正缓存前对序列化后的 CardRate 把关——报价必须有限正数、
    // updated 必须合法且非未来；畸形 payload（NaN/Infinity/Invalid Date/负价）抛错
    // 进负缓存、绝不写正缓存。
    validateStored: validateCardRate,
});

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

    // 稀疏汇率矩阵（Phase 5）：行/单元格按需物化，绝不全量构建 N² 个 Proxy cell；
    // 单元格是 typed 正缓存（CardRate）的 live getter 视图，字段读取零 JSON.parse。
    // FXRATE_CARD_DENSE_MATRIX=1 时回退全量 typed 密集矩阵（排查稀疏差异用）。
    private _sparseMatrix: {
        [from: string]: { [to: string]: FXRateType };
    } | null = null;

    private readonly sparseStats: CardSparseStats = { rows: 0, cells: 0 };

    /** 已物化的稀疏行数（测试/基准可观测）。 */
    public get sparseRows(): number {
        return this.sparseStats.rows;
    }

    /** 已物化的稀疏单元格数（测试/基准可观测）。 */
    public get sparseCells(): number {
        return this.sparseStats.cells;
    }

    public get fxRateList() {
        if (!this._sparseMatrix) {
            this._sparseMatrix = createCardMatrix(
                currenciesList,
                cache,
                normalizeCode,
                this.sparseStats,
            );
        }
        return this._sparseMatrix;
    }

    public async getfxRateList(from: currency, to: currency) {
        if (
            !(
                currenciesList.includes(from as string) &&
                currenciesList.includes(to as string)
            )
        ) {
            throw new Error('Currency not supported');
        }

        await mastercardCoordinator.get(from as string, to as string);
        return this.fxRateList[from][to];
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

    // 同步可用数据判定：数据在模块级 typed LRU cache（不触碰 fxRateList 稀疏矩阵）；
    // 缓存里有任何成功拉取的记录即视为已加载可用数据。
    public hasUsableData(): boolean {
        return cache.size > 0;
    }

    public update(): void {
        throw new Error('Method is deprecated');
    }
}
