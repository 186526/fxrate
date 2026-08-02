import fxManager, { FXRateType } from '../fxm/fxManager';
import { fraction } from 'mathjs';

import { LRUCache } from 'lru-cache';
import { currency } from 'src/types.d';
import { existsSync } from 'node:fs';

const cache = new LRUCache<string, string>({
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

// headless chromium 直连（Cloudflare 拦非浏览器客户端时启用）。
// 动态 import：没有安装 playwright-core / chromium 的环境（如 Vercel serverless）降级走 fetch。
type ChromiumPage = {
    goto: (
        url: string,
        opts: object,
    ) => Promise<{ status: () => number } | null>;
    evaluate: <T>(fn: () => T) => Promise<T>;
};
type ChromiumBrowser = {
    newContext: (opts: object) => Promise<{
        newPage: () => Promise<ChromiumPage>;
    }>;
    close: () => Promise<void>;
};
let chromiumLauncher:
    | (() => Promise<{ launch: (opts: object) => Promise<ChromiumBrowser> }>)
    | null = null;
let chromiumInitError: Error | null = null;
async function getChromium() {
    if (chromiumInitError) throw chromiumInitError;
    if (!chromiumLauncher) {
        try {
            const mod = await import('playwright-core');
            chromiumLauncher = () =>
                Promise.resolve({
                    launch: async (opts: object) => {
                        const browser = await (
                            mod as unknown as {
                                chromium: {
                                    launch: (
                                        o: object,
                                    ) => Promise<ChromiumBrowser>;
                                };
                            }
                        ).chromium.launch(opts);
                        return browser;
                    },
                });
        } catch (e) {
            chromiumInitError = new Error(
                `playwright-core not available: ${(e as Error).message}`,
            );
            throw chromiumInitError;
        }
    }
    return chromiumLauncher();
}

// 常见 chromium 可执行文件路径（本地 / Docker 部署）。
function chromiumExecutable(): string | undefined {
    if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
    const candidates = [
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
        '/home/real186/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
    ];
    for (const p of candidates) {
        if (existsSync(p)) return p;
    }
    return undefined;
}

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
    const executablePath = chromiumExecutable();
    if (!executablePath) {
        throw new Error('chromium executable not found');
    }
    const launcher = await getChromium();

    const browser = await launcher.launch({
        executablePath,
        headless: true,
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    });
    try {
        // 必须用非 headless 标识的 UA：Cloudflare 会拦截 Playwright 默认的
        // "HeadlessChrome" UA（实测 403），newContext 设置 UA 才能改网络层请求头。
        const context = await browser.newContext({
            userAgent:
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
                '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        });
        const page = await context.newPage();

        for (let offset = 0; offset < 7; offset++) {
            const date = new Date();
            date.setUTCDate(date.getUTCDate() - offset);
            const d = formatApiDate(date);
            const url =
                `${VISA_API_BASE}?amount=1&fee=0` +
                `&utcConvertedDate=${d}&exchangedate=${d}` +
                `&fromCurr=${to}&toCurr=${from}`;

            const resp = await page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: 45000,
            });
            const status = resp?.status() ?? 0;
            const text = await page.evaluate(() => document.body.innerText);
            if (status === 200) {
                const payload = JSON.parse(text) as VisaPayload;
                if (!payload.originalValues?.fxRateVisa) {
                    throw new Error(
                        `Visa response missing fxRateVisa for ${from}/${to}`,
                    );
                }
                return payload;
            }
            if (status === 400) continue;
            throw new Error(
                `Visa API ${status} via chromium for ${from}/${to} (${d})`,
            );
        }
        throw new Error(
            `Visa no published rate in last 7 days for ${from}/${to} (chromium)`,
        );
    } finally {
        await browser.close();
    }
}

export default class visaFXM extends fxManager {
    ableToGetAllFXRate: boolean = false;

    private _lazyMatrix: {
        [from: string]: { [to: string]: FXRateType };
    } | null = null;

    public get fxRateList() {
        if (this._lazyMatrix) return this._lazyMatrix;

        const fxRateList: fxManager['_fxRateList'] = {};

        currenciesList.forEach((from) => {
            fxRateList[from] = {};
            currenciesList.forEach((to) => {
                const _from = from == 'CNH' ? 'CNY' : from;
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
                        if (!cached) return undefined;

                        const data = JSON.parse(cached) as VisaPayload;
                        if (
                            ['cash', 'remit', 'middle'].includes(
                                prop.toString(),
                            )
                        ) {
                            // fxRateVisa 即「1 from = X to」（实测响应 originalValues.fromCurrency == from）。
                            return fraction(
                                Number(data.originalValues?.fxRateVisa),
                            );
                        }
                        const updated = new Date(
                            (data.originalValues?.lastUpdatedVisaRate ?? 0) *
                                1000,
                        );
                        return Number.isFinite(updated.getTime())
                            ? updated
                            : new Date();
                    },
                });
                fxRateList[from][to] = currency;
            });
        });

        this._lazyMatrix = fxRateList;
        return fxRateList;
    }

    public async getfxRateList(from: currency, to: currency) {
        const _from = (from == 'CNH' ? 'CNY' : from) as string;
        const _to = (to == 'CNH' ? 'CNY' : to) as string;

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

        let payload: VisaPayload;
        try {
            payload = await fetchVisaRate(_from, _to);
        } catch (fetchErr) {
            try {
                payload = await fetchVisaRateViaChromium(_from, _to);
            } catch (chromiumErr) {
                throw new Error(
                    `Visa ${_from}/${_to} unavailable: ${(fetchErr as Error).message}; ` +
                        `chromium fallback failed: ${(chromiumErr as Error).message}`,
                );
            }
        }
        cache.set(`${_from}${_to}`, JSON.stringify(payload));

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

    public update(): void {
        throw new Error('Method is deprecated');
    }
}
