import { existsSync } from 'node:fs';

import { FXRate, currency } from 'src/types.d';

const PAGE_URL =
    'https://www.hkbea.com/hk-form/?formId=RATE&rateType=ttfx&language=en';
const RATE_URL_PART = '/hk-form/eform-api/v1/misc/enquiry/RATE/ttfx';
const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36';

interface BEARateData {
    timestamp?: string;
    ttfxRates?: string[];
}

interface BEAResponse {
    status?: number;
    error?: string;
    message?: string;
    data?: BEARateData;
}

const chromiumExecutable = (): string | undefined => {
    const candidates = [
        process.env['CHROMIUM_PATH'],
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
        '/home/real186/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
    ].filter((path): path is string => Boolean(path));
    return candidates.find((path) => existsSync(path));
};

const fetchViaChromium = async (): Promise<BEAResponse> => {
    const executablePath = chromiumExecutable();
    if (!executablePath) {
        throw new Error('chromium executable not found');
    }

    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({
        executablePath,
        headless: true,
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    });
    try {
        const context = await browser.newContext({
            ignoreHTTPSErrors: true,
            userAgent: process.env['HEADER_USER_AGENT'] ?? USER_AGENT,
        });
        const page = await context.newPage();
        const errors: string[] = [];

        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const responsePromise = page.waitForResponse(
                    (response) =>
                        response.url().includes(RATE_URL_PART) &&
                        response.request().method() === 'POST' &&
                        response.status() === 200,
                    { timeout: 60000 },
                );
                const navigationPromise =
                    attempt === 0
                        ? page.goto(PAGE_URL, {
                              waitUntil: 'domcontentloaded',
                              timeout: 60000,
                          })
                        : page.reload({
                              waitUntil: 'domcontentloaded',
                              timeout: 60000,
                          });
                const [response] = await Promise.all([
                    responsePromise,
                    navigationPromise,
                ]);
                const payload = (await response.json()) as BEAResponse;
                if (
                    payload.status === 9000 &&
                    Array.isArray(payload.data?.ttfxRates)
                ) {
                    return payload;
                }
                throw new Error(
                    payload.error ||
                        payload.message ||
                        `API status ${String(payload.status)}`,
                );
            } catch (error) {
                errors.push((error as Error).message);
                if (attempt === 0) await page.waitForTimeout(5000);
            }
        }

        throw new Error(errors.join('; '));
    } finally {
        await browser.close();
    }
};

const parseUpdated = (value?: string): Date => {
    const match = value?.match(
        /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/,
    );
    if (!match) return new Date();
    const updated = new Date(
        `${match[3]}-${match[2]}-${match[1]}T${match[4]}:${match[5]}:00+08:00`,
    );
    return Number.isFinite(updated.getTime()) ? updated : new Date();
};

const parseRates = (data?: BEARateData): FXRate[] => {
    const updated = parseUpdated(data?.timestamp);
    const rates: FXRate[] = [];
    for (const row of data?.ttfxRates ?? []) {
        const [from, unitText, buyText, sellText] = row.split(';');
        const unit = Number(unitText?.replace(/,/g, ''));
        const buy = Number(buyText);
        const sell = Number(sellText);
        if (
            !/^[A-Z]{3}$/.test(from) ||
            !Number.isFinite(unit) ||
            !Number.isFinite(buy) ||
            !Number.isFinite(sell) ||
            unit <= 0 ||
            buy <= 0 ||
            sell <= 0 ||
            buy >= sell
        ) {
            continue;
        }

        rates.push({
            currency: {
                from: from as unknown as currency.unknown,
                to: 'HKD' as currency.HKD,
            },
            rate: {
                buy: { remit: buy },
                sell: { remit: sell },
                middle: (buy + sell) / 2,
            },
            unit,
            updated,
        });
    }
    return rates.sort();
};

const getBEAFXRates = async (): Promise<FXRate[]> => {
    try {
        const rates = parseRates((await fetchViaChromium()).data);
        if (rates.length > 0) return rates;
        throw new Error('response contained no valid rates');
    } catch (error) {
        throw new Error(`BEA Hong Kong unavailable: ${(error as Error).message}`);
    }
};

export default getBEAFXRates;
