import fxManager, { FXRateType } from '../fxm/fxManager';
import { fraction } from 'mathjs';

import { LRUCache } from 'lru-cache';
import { currency } from 'src/types.d';

import { fetchTextViaChromium } from './chromiumFetcher';
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

// visa.co.in 的 WAF（Cloudflare）比 visa.co.uk / visa.com 宽松：
// 无浏览器会话的原生 fetch 也可能被拦截（403），此时降级用 headless chromium 直连。
const VISA_API_BASE = 'https://www.visa.co.in/cmsapi/fx/rates';

const currenciesList: string[] = [
    'AED',
    'AFN',
    'ALL',
    'AMD',
    'ANG',
    'AOA',
    'ARS',
    'AUD',
    'AWG',
    'AZN',
    'BAM',
    'BBD',
    'BDT',
    'BGN',
    'BHD',
    'BIF',
    'BMD',
    'BND',
    'BOB',
    'BRL',
    'BSD',
    'BTN',
    'BWP',
    'BYN',
    'BZD',
    'CAD',
    'CDF',
    'CHF',
    'CLP',
    'CNY',
    'CNH',
    'COP',
    'CRC',
    'CVE',
    'CYP',
    'CZK',
    'DJF',
    'DKK',
    'DOP',
    'DZD',
    'EEK',
    'EGP',
    'ERN',
    'ETB',
    'EUR',
    'FJD',
    'FKP',
    'GBP',
    'GEL',
    'GHS',
    'GIP',
    'GMD',
    'GNF',
    'GQE',
    'GTQ',
    'GWP',
    'GYD',
    'HKD',
    'HNL',
    'HRK',
    'HTG',
    'HUF',
    'IDR',
    'ILS',
    'INR',
    'IQD',
    'IRR',
    'ISK',
    'JMD',
    'JOD',
    'JPY',
    'KES',
    'KGS',
    'KHR',
    'KMF',
    'KRW',
    'KWD',
    'KYD',
    'KZT',
    'LAK',
    'LBP',
    'LKR',
    'LRD',
    'LSL',
    'LTL',
    'LVL',
    'LYD',
    'MAD',
    'MDL',
    'MGA',
    'MKD',
    'MMK',
    'MNT',
    'MOP',
    'MRO',
    'MRU',
    'MTL',
    'MUR',
    'MVR',
    'MWK',
    'MXN',
    'MYR',
    'MZN',
    'NAD',
    'NGN',
    'NIO',
    'NOK',
    'NPR',
    'NZD',
    'None',
    'OMR',
    'PAB',
    'PEN',
    'PGK',
    'PHP',
    'PKR',
    'PLN',
    'PYG',
    'QAR',
    'RON',
    'RSD',
    'RUB',
    'RWF',
    'SAR',
    'SBD',
    'SCR',
    'SDG',
    'SEK',
    'SGD',
    'SHP',
    'SIT',
    'SKK',
    'SLL',
    'SOS',
    'SRD',
    'SSP',
    'STD',
    'STN',
    'SVC',
    'SYP',
    'SZL',
    'THB',
    'TJS',
    'TMT',
    'TND',
    'TOP',
    'TRY',
    'TTD',
    'TWD',
    'TZS',
    'UAH',
    'UGX',
    'USD',
    'UYU',
    'UZS',
    'VEF',
    'VES',
    'VND',
    'VUV',
    'WST',
    'XAF',
    'XCD',
    'XOF',
    'XPF',
    'YER',
    'ZAR',
    'ZMW',
    'ZWL',
];

type VisaPayload = {
    originalValues?: {
        fxRateVisa?: string | number;
        lastUpdatedVisaRate?: number;
    };
};

function formatApiDate(d: Date): string {
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${m}/${day}/${d.getUTCFullYear()}`;
}

async function fetchVisaRate(from: string, to: string): Promise<VisaPayload> {
    // Visa 每日发布一次，当天未发布时 400；从 UTC 今天向前回退最多 7 天。
    for (let offset = 0; offset < 7; offset++) {
        const date = new Date();
        date.setUTCDate(date.getUTCDate() - offset);
        const d = formatApiDate(date);

        // 请求方向：API 的 fromCurr/toCurr 相对 UI 反转（fromCurr=to、toCurr=from），
        // 响应里 originalValues.fxRateVisa 即「1 from = X to」。
        const url =
            `${VISA_API_BASE}?amount=1&fee=0` +
            `&utcConvertedDate=${d}&exchangedate=${d}` +
            `&fromCurr=${to}&toCurr=${from}`;

        let res: Response;
        try {
            res = await fetch(url, {
                signal: AbortSignal.timeout(10000),
                headers: {
                    accept: 'application/json, text/plain, */*',
                    'user-agent':
                        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
                        'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                },
            });
        } catch (e) {
            throw new Error(
                `Visa network error for ${from}/${to}: ${(e as Error).message}`,
            );
        }

        if (res.status === 200) {
            const payload = (await res.json()) as VisaPayload;
            if (!payload.originalValues?.fxRateVisa) {
                throw new Error(
                    `Visa response missing fxRateVisa for ${from}/${to}`,
                );
            }
            return payload;
        }
        if (res.status === 400) continue;
        throw new Error(`Visa API ${res.status} for ${from}/${to} (${d})`);
    }
    throw new Error(`Visa no published rate in last 7 days for ${from}/${to}`);
}

async function fetchVisaRateViaChromium(
    from: string,
    to: string,
): Promise<VisaPayload> {
    const urls: string[] = [];
    for (let offset = 0; offset < 7; offset++) {
        const date = new Date();
        date.setUTCDate(date.getUTCDate() - offset);
        const d = formatApiDate(date);
        urls.push(
            `${VISA_API_BASE}?amount=1&fee=0` +
                `&utcConvertedDate=${d}&exchangedate=${d}` +
                `&fromCurr=${to}&toCurr=${from}`,
        );
    }

    const text = await fetchTextViaChromium(urls);
    const payload = JSON.parse(text) as VisaPayload;
    if (!payload.originalValues?.fxRateVisa) {
        throw new Error(`Visa response missing fxRateVisa for ${from}/${to}`);
    }
    return payload;
}

const normalizeCode = (code: string): string => (code === 'CNH' ? 'CNY' : code);

export const visaCoordinator = new CardCoordinator<VisaPayload, CardRate>({
    source: 'visa',
    positive: cache,
    negative: createCardNegativeCache(),
    normalize: normalizeCode,
    nativeWorkflow: fetchVisaRate,
    chromiumWorkflow: fetchVisaRateViaChromium,
    validate: (payload) => {
        if (!payload.originalValues?.fxRateVisa) {
            throw new Error('Visa response missing fxRateVisa');
        }
    },
    // 上游响应写缓存时一次性解析为类型化 CardRate（Proxy 读取零 JSON.parse）：
    // fxRateVisa 即「1 from = X to」（实测响应 originalValues.fromCurrency == from）。
    serialize: (payload) => {
        const value = fraction(Number(payload.originalValues?.fxRateVisa));
        // lastUpdatedVisaRate 缺失/非有限/非正数 → Invalid Date，由 validateStored 拒进
        // 正缓存（绝不让缺失时间戳静默变成 epoch/当前时间）。
        const ts = payload.originalValues?.lastUpdatedVisaRate;
        const updated =
            typeof ts === 'number' && Number.isFinite(ts) && ts > 0
                ? new Date(ts * 1000)
                : new Date(Number.NaN);
        return {
            middle: value,
            cash: value,
            remit: value,
            updated,
        };
    },
    // 最终校验门：写正缓存前对序列化后的 CardRate 把关——报价必须有限正数、
    // updated 必须合法且非未来；畸形 payload（NaN/Infinity/Invalid Date/负价）抛错
    // 进负缓存、绝不写正缓存。
    validateStored: validateCardRate,
});

export default class visaFXM extends fxManager {
    ableToGetAllFXRate: boolean = false;

    // 稀疏汇率矩阵（Phase 5）：行/单元格按需物化，绝不全量构建 N² 个 Proxy cell；
    // 单元格是 typed 正缓存（CardRate）的 live getter 视图，字段读取零 JSON.parse。
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

        await visaCoordinator.get(from as string, to as string);
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
